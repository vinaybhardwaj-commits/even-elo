import pytest
from langchain_core.messages import HumanMessage, AIMessage
from src.visualization_router import (
    decision_from_response,
    routing_input,
    routed_request,
)
from langchain.agents.middleware import ModelRequest
from langchain_core.messages import SystemMessage


def response(choice):
    return {
        "answers": {
            "visualization": {
                "type": "choice",
                "choice": choice,
                "confidence": 0.9,
                "probabilities": {choice: 0.9},
            }
        }
    }


@pytest.mark.parametrize(
    ("choice", "renderer"),
    [
        ("table", "a2ui"),
        ("line_chart", "open_generative_ui"),
        ("interactive_diagram", "open_generative_ui"),
        ("text", "text"),
    ],
)
def test_valid_decisions_map_to_exact_renderer(choice, renderer):
    assert decision_from_response(response(choice))["renderer"] == renderer


@pytest.mark.parametrize(
    "raw",
    [{}, response("invented"), {"answers": {"visualization": {"choice": "table"}}}],
)
def test_bad_decisions_fail_loudly(raw):
    with pytest.raises(ValueError, match="Jev"):
        decision_from_response(raw)


def test_continuation_reuses_decision_but_new_human_reroutes():
    state = {
        "messages": [HumanMessage(content="table", id="one")],
        "visualization_turn": "one",
        "visualization_decision": decision_from_response(response("table")),
    }
    assert routing_input(state) is None
    state["messages"].append(AIMessage(content="done"))
    assert routing_input(state) is None
    state["messages"].append(HumanMessage(content="now chart it", id="two"))
    turn, context = routing_input(state)
    assert turn == "two"
    assert context[-1]["content"] == "now chart it"


@pytest.mark.parametrize(
    ("choice", "allowed"),
    [
        ("table", "send_a2ui_json_to_client"),
        ("line_chart", "generateSandboxedUi"),
        ("text", None),
    ],
)
def test_route_filters_renderers_preserving_data_tools(choice, allowed):
    tools = [
        {"name": n}
        for n in [
            "render_a2ui",
            "send_a2ui_json_to_client",
            "generate_a2ui",
            "generateSandboxedUi",
            "barChart",
            "pieChart",
            "some_data_tool",
        ]
    ]
    request = ModelRequest(
        model=None,
        messages=[],
        tools=tools,
        system_message=SystemMessage(content="base"),
        state={"visualization_decision": decision_from_response(response(choice))},
    )
    result = routed_request(request)
    names = {t["name"] for t in result.tools}
    assert "some_data_tool" in names
    assert ("generateSandboxedUi" in names) == (allowed == "generateSandboxedUi")
    assert ("send_a2ui_json_to_client" in names) == (
        allowed == "send_a2ui_json_to_client"
    )
    # @copilotkit/runtime's locked A2UI middleware injects render_a2ui.
    assert ("render_a2ui" in names) == (choice == "table")
    assert "barChart" not in names and "pieChart" not in names


@pytest.mark.parametrize("choice", ["map", "animated_route"])
def test_removed_demo_visualizations_are_rejected(choice):
    with pytest.raises(ValueError):
        decision_from_response(response(choice))


def test_jev_key_comes_only_from_env(monkeypatch):
    from src.visualization_router import request_options

    monkeypatch.setenv("TYPESAFE_API_KEY", "env-key")
    options = request_options([])
    assert options["headers"] == {"Authorization": "Bearer env-key"}
    assert "x-jev-api-key" not in {k.lower() for k in options["headers"]}


def test_missing_key_is_actionable(monkeypatch):
    from src.visualization_router import request_options

    monkeypatch.delenv("TYPESAFE_API_KEY", raising=False)
    with pytest.raises(ValueError, match="TYPESAFE_API_KEY"):
        request_options([])


def test_provider_errors_do_not_expose_response_body():
    import httpx
    from src.visualization_router import parse_response

    with pytest.raises(ValueError, match="HTTP 401") as error:
        parse_response(httpx.Response(401, text="sensitive provider details"))
    assert "sensitive" not in str(error.value)


def test_timeout_is_actionable_without_secret_headers(monkeypatch):
    import httpx
    import src.visualization_router as router

    monkeypatch.setenv("TYPESAFE_API_KEY", "private-test-value")

    def timeout(*args, **kwargs):
        raise httpx.ReadTimeout("private-test-value")

    monkeypatch.setattr(httpx.Client, "post", timeout)
    with pytest.raises(ValueError, match="timed out") as error:
        router.route([])
    assert "private-test-value" not in str(error.value)


def test_context_excludes_system_and_tool_content_and_is_bounded():
    from langchain_core.messages import ToolMessage

    state = {
        "messages": [
            SystemMessage(content="secret system"),
            ToolMessage(content="tool payload", tool_call_id="x"),
            HumanMessage(content="a" * 20000, id="bounded"),
        ]
    }
    _, context = routing_input(state)
    assert len(context) == 1
    assert len(context[0]["content"]) == 6000


def test_real_graph_filters_injected_frontend_tools_and_routes_once(monkeypatch):
    import asyncio
    from deepagents import create_deep_agent
    from copilotkit import CopilotKitMiddleware
    from langchain_core.language_models.fake_chat_models import (
        FakeMessagesListChatModel,
    )
    from langgraph.checkpoint.memory import InMemorySaver
    import src.visualization_router as router

    bound = []
    calls = []

    class FakeModel(FakeMessagesListChatModel):
        def bind_tools(self, tools, **kwargs):
            bound.append(
                {t.get("name") if isinstance(t, dict) else t.name for t in tools}
            )
            return self

    async def classify(context):
        calls.append(context)
        return decision_from_response(response("interactive_diagram"))

    monkeypatch.setattr(router, "aroute", classify)
    graph = create_deep_agent(
        model=FakeModel(responses=[AIMessage(content="Ready")]),
        middleware=[CopilotKitMiddleware(), router.JevVisualizationMiddleware()],
        checkpointer=InMemorySaver(),
    )

    async def run():
        config = {"configurable": {"thread_id": "routing-test"}}
        actions = [
            {
                "name": name,
                "description": name,
                "parameters": {"type": "object", "properties": {}},
            }
            for name in ["generateSandboxedUi", "render_a2ui", "send_a2ui_json_to_client", "barChart"]
        ]
        await graph.ainvoke(
            {
                "messages": [HumanMessage(content="Explain gears", id="one")],
                "copilotkit": {"actions": actions},
            },
            config,
        )
        await graph.ainvoke({"messages": []}, config)
        assert len(calls) == 1
        await graph.ainvoke(
            {"messages": [HumanMessage(content="Now explain torque", id="two")]}, config
        )
        assert len(calls) == 2

    asyncio.run(run())
    assert bound and all(
        "generateSandboxedUi" in tools
        and "render_a2ui" not in tools
        and "barChart" not in tools
        and "send_a2ui_json_to_client" not in tools
        for tools in bound
    )


def test_jev_context_has_human_turns_only_never_ai_or_tool_text():
    from langchain_core.messages import ToolMessage

    state = {
        "messages": [
            HumanMessage(content="who are our cardiologists?", id="h1"),
            AIMessage(content="Dr Sample Physician A and Dr Sample Physician B (signals: ...)"),
            ToolMessage(content="LEAK-ROWS physician names", tool_call_id="t"),
            HumanMessage(content="chart it", id="h2"),
            AIMessage(content="LEAK-AI-TEXT"),
            HumanMessage(content="as a table", id="h3"),
        ]
    }
    turn, context = routing_input(state)
    assert turn == "h3"
    assert [c["role"] for c in context] == ["human", "human", "human"]
    blob = str(context)
    assert "LEAK" not in blob and "Dr Sample" not in blob


def test_jev_request_body_never_carries_ai_text(monkeypatch):
    from src.visualization_router import request_options

    monkeypatch.setenv("TYPESAFE_API_KEY", "env-key")
    state = {"messages": [HumanMessage(content="hi", id="a"), AIMessage(content="LEAK-AI"), HumanMessage(content="more", id="b")]}
    _, context = routing_input(state)
    assert "LEAK-AI" not in str(request_options(context))


def test_last_four_human_texts_only():
    state = {"messages": [HumanMessage(content=f"q{i}", id=str(i)) for i in range(7)]}
    _, context = routing_input(state)
    assert [c["content"] for c in context] == ["q3", "q4", "q5", "q6"]


def test_idless_continuation_has_stable_turn_key():
    state = {"messages": [HumanMessage(content="table")]}
    turn, _ = routing_input(state)
    state.update(
        visualization_turn=turn,
        visualization_decision=decision_from_response(response("table")),
    )
    state["messages"].append(AIMessage(content="done"))
    assert routing_input(state) is None
    state["messages"].append(HumanMessage(content="table"))
    assert routing_input(state)[0] != turn


def test_jev_client_uses_configured_proxy(monkeypatch):
    import httpx
    from src import visualization_router as vr

    seen = []
    real_client = httpx.Client

    def capture(**kwargs):
        seen.append(kwargs)
        return real_client(transport=httpx.MockTransport(lambda r: httpx.Response(500)))

    monkeypatch.setenv("HTTPS_PROXY", "http://127.0.0.1:8888")
    monkeypatch.setattr(vr.httpx, "Client", capture)
    with pytest.raises(ValueError):
        vr.route({})
    assert seen and seen[0]["proxy"] == "http://127.0.0.1:8888" and seen[0]["trust_env"] is False


def test_jev_client_without_proxy_env(monkeypatch):
    from src import visualization_router as vr

    monkeypatch.delenv("HTTPS_PROXY", raising=False)
    assert "proxy" not in vr.client_options()
