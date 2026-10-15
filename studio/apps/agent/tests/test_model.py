"""Bedrock primary / Vertex fallback wiring. All provider classes are mocked: no live calls."""

import asyncio
import logging

import pytest
from langchain_core.language_models.chat_models import BaseChatModel
from langchain_core.messages import AIMessage, AIMessageChunk, HumanMessage
from langchain_core.outputs import ChatGeneration, ChatGenerationChunk, ChatResult

import src.model as model_mod
from src.model import (
    DEFAULT_BEDROCK_REGION,
    DEFAULT_VERTEX_LOCATION,
    FallbackChatModel,
    UnconfiguredModel,
    build_bedrock,
    build_model,
    build_vertex,
    served_model_id,
)

SONNET_ID = "test.sonnet-model-id-v1:0"
HAIKU_ID = "test.haiku-model-id-v1:0"


@pytest.fixture(autouse=True)
def clean_env(monkeypatch):
    for name in (
        "BEDROCK_AUTH", "GCP_SA_KEY_JSON", "GCP_SA_KEY_FILE", "GCP_AUDIENCE", "AWS_ROLE_ARN",
        "BEDROCK_REGION", "BEDROCK_MODEL_SONNET", "BEDROCK_MODEL_HAIKU",
        "VERTEX_LOCATION", "VERTEX_MODEL",
    ):
        monkeypatch.delenv(name, raising=False)


class FakeProvider(BaseChatModel):
    """Stand-in for a provider class: records kwargs, serves a named model id."""

    served: str = "served-id"
    fail: bool = False
    fail_after_chunks: int | None = None
    calls: list = []
    bound: list = []

    @property
    def _llm_type(self):
        return "fake"

    def bind_tools(self, tools, **kwargs):
        self.bound.append(([t for t in tools], kwargs))
        return self

    def _generate(self, messages, stop=None, run_manager=None, **kwargs):
        self.calls.append("generate")
        if self.fail:
            raise RuntimeError("boom")
        msg = AIMessage(content="ok", response_metadata={"model_name": self.served})
        return ChatResult(generations=[ChatGeneration(message=msg)])

    def _stream(self, messages, stop=None, run_manager=None, **kwargs):
        self.calls.append("stream")
        for i, text in enumerate(["a", "b", "c"]):
            if self.fail and (self.fail_after_chunks is None or i >= self.fail_after_chunks):
                raise RuntimeError("boom")
            yield ChatGenerationChunk(
                message=AIMessageChunk(content=text, response_metadata={"model_name": self.served})
            )


def fresh(**kw):
    return FakeProvider(calls=[], bound=[], **kw)


# ---- construction -------------------------------------------------------

def test_bedrock_uses_env_ids_and_default_region(monkeypatch):
    monkeypatch.setenv("BEDROCK_AUTH", "default-chain")
    seen = {}

    class FakeBedrock(FakeProvider):
        def __init__(self, **kwargs):
            seen.update(kwargs)
            super().__init__()

    monkeypatch.setattr("langchain_aws.ChatBedrockConverse", FakeBedrock)
    monkeypatch.setenv("BEDROCK_MODEL_SONNET", SONNET_ID)
    monkeypatch.setenv("BEDROCK_MODEL_HAIKU", HAIKU_ID)
    build_bedrock("sonnet")
    assert seen["model_id"] == SONNET_ID
    assert seen["region_name"] == DEFAULT_BEDROCK_REGION == "ap-south-1"
    assert seen["max_tokens"] >= 32000
    assert seen["disable_streaming"] is False
    monkeypatch.setenv("BEDROCK_REGION", "eu-west-1")
    build_bedrock("haiku")
    assert seen["model_id"] == HAIKU_ID
    assert seen["region_name"] == "eu-west-1"


def test_bedrock_requires_model_id_and_known_name(monkeypatch):
    monkeypatch.setenv("BEDROCK_AUTH", "default-chain")
    with pytest.raises(ValueError, match="BEDROCK_MODEL_SONNET"):
        build_bedrock("sonnet")
    with pytest.raises(ValueError, match="Unknown model name"):
        build_bedrock("opus")


def test_vertex_is_none_without_model_and_uses_env(monkeypatch):
    assert build_vertex() is None
    seen = {}

    class FakeGemini(FakeProvider):
        def __init__(self, **kwargs):
            seen.update(kwargs)
            super().__init__()

    monkeypatch.setattr("langchain_google_genai.ChatGoogleGenerativeAI", FakeGemini)
    monkeypatch.setenv("VERTEX_MODEL", "gemini-test")
    build_vertex()
    assert seen["model"] == "gemini-test"
    assert seen["vertexai"] is True
    assert seen["location"] == DEFAULT_VERTEX_LOCATION == "asia-northeast1"
    monkeypatch.setenv("VERTEX_LOCATION", "us-central1")
    build_vertex()
    assert seen["location"] == "us-central1"


def test_build_model_unconfigured_only_when_allowed():
    assert isinstance(build_model(allow_unconfigured=True), UnconfiguredModel)
    with pytest.raises(ValueError):
        build_model()


def test_build_model_wraps_primary_with_lazy_fallback(monkeypatch):
    built = []
    monkeypatch.setattr(model_mod, "build_bedrock", lambda name: built.append(name) or fresh())
    monkeypatch.setattr(model_mod, "build_vertex", lambda: pytest.fail("fallback must be lazy"))
    wrapped = build_model("haiku")
    assert isinstance(wrapped, FallbackChatModel)
    assert built == ["haiku"]


def test_served_model_id_reads_metadata_only():
    assert served_model_id(AIMessage(content="x", response_metadata={"model_name": "m1"})) == "m1"
    assert served_model_id(AIMessage(content="x")) is None


# ---- fallback behaviour --------------------------------------------------

def test_primary_success_never_touches_fallback(caplog):
    primary, backup = fresh(served="primary-id"), fresh(served="fallback-id")
    m = FallbackChatModel(primary=primary, fallback_factory=lambda: backup)
    with caplog.at_level(logging.INFO, logger="agent.model"):
        out = m.invoke([HumanMessage(content="secret prompt")])
    assert out.content == "ok"
    assert backup.calls == []
    assert "served model id=primary-id route=primary" in caplog.text
    assert "secret prompt" not in caplog.text


def test_primary_error_falls_back_and_logs(caplog):
    primary, backup = fresh(fail=True), fresh(served="fallback-id")
    m = FallbackChatModel(primary=primary, fallback_factory=lambda: backup)
    with caplog.at_level(logging.INFO, logger="agent.model"):
        out = m.invoke([HumanMessage(content="hi")])
    assert out.content == "ok"
    assert backup.calls == ["generate"]
    assert "primary model sonnet failed (RuntimeError); using Vertex fallback" in caplog.text
    assert "served model id=fallback-id route=fallback" in caplog.text


def test_error_without_fallback_is_raised():
    m = FallbackChatModel(primary=fresh(fail=True), fallback_factory=lambda: None)
    with pytest.raises(RuntimeError, match="boom"):
        m.invoke([HumanMessage(content="hi")])


def test_async_fallback():
    primary, backup = fresh(fail=True), fresh(served="fb")
    m = FallbackChatModel(primary=primary, fallback_factory=lambda: backup)
    out = asyncio.run(m.ainvoke([HumanMessage(content="hi")]))
    assert out.content == "ok"
    assert backup.calls  # async path delegates to the sync implementation of the fake


def test_stream_falls_back_only_before_first_chunk():
    backup = fresh(served="fb")
    m = FallbackChatModel(primary=fresh(fail=True), fallback_factory=lambda: backup)
    assert "".join(c.content for c in m.stream([HumanMessage(content="hi")])) == "abc"
    assert backup.calls == ["stream"]

    backup2 = fresh()
    mid = FallbackChatModel(primary=fresh(fail=True, fail_after_chunks=1), fallback_factory=lambda: backup2)
    with pytest.raises(RuntimeError):
        list(mid.stream([HumanMessage(content="hi")]))
    assert backup2.calls == []  # never splice two providers into one answer


def test_bind_tools_binds_primary_now_and_fallback_lazily():
    primary, backup = fresh(fail=True), fresh()
    m = FallbackChatModel(primary=primary, fallback_factory=lambda: backup)

    def tool():  # pragma: no cover - identity only
        pass

    bound = m.bind_tools([tool], tool_choice="auto")
    assert primary.bound == [([tool], {"tool_choice": "auto"})]
    assert backup.bound == []
    bound.invoke([HumanMessage(content="hi")])
    assert backup.bound == [([tool], {"tool_choice": "auto"})]


def test_no_credentials_in_logs_or_repr(monkeypatch, caplog):
    monkeypatch.setenv("AWS_SECRET_ACCESS_KEY", "super-secret-value")
    m = FallbackChatModel(primary=fresh(fail=True), fallback_factory=lambda: fresh())
    with caplog.at_level(logging.DEBUG, logger="agent.model"):
        m.invoke([HumanMessage(content="hi")])
    assert "super-secret-value" not in caplog.text


# ---- single-run regression (R3 blocker: deltas were emitted twice) ---------

def _delta_texts(events):
    return [
        e["data"]["chunk"].content
        for e in events
        if e["event"] == "on_chat_model_stream" and e["data"]["chunk"].content
    ]


def _model_runs(events):
    return [e for e in events if e["event"] == "on_chat_model_start"]


class WordFake(FakeProvider):
    """Streams words through the real BaseChatModel callback plumbing, like a provider."""

    words: list = ["alpha ", "beta ", "gamma"]

    def _stream(self, messages, stop=None, run_manager=None, **kwargs):
        self.calls.append("stream")
        if self.fail:
            raise RuntimeError("boom")
        for w in self.words:
            chunk = ChatGenerationChunk(message=AIMessageChunk(content=w, response_metadata={"model_name": self.served}))
            if run_manager:  # providers do this; the wrapper must not double it
                run_manager.on_llm_new_token(w, chunk=chunk)
            yield chunk


def _events(model):
    async def go():
        return [e async for e in model.astream_events([HumanMessage(content="hi")], version="v2")]

    return asyncio.run(go())


def test_wrapped_stream_events_match_bare_model():
    bare = _events(WordFake(calls=[], bound=[]))
    wrapped = _events(FallbackChatModel(primary=WordFake(calls=[], bound=[]), fallback_factory=lambda: None))
    assert _delta_texts(bare) == ["alpha ", "beta ", "gamma"]
    assert _delta_texts(wrapped) == _delta_texts(bare)  # each delta exactly once
    assert len(_model_runs(wrapped)) == 1  # one visible chat-model run


def test_fallback_stream_events_emit_once_and_single_run():
    wrapped = FallbackChatModel(
        primary=WordFake(calls=[], bound=[], fail=True),
        fallback_factory=lambda: WordFake(calls=[], bound=[], words=["x ", "y"]),
    )
    events = _events(wrapped)
    assert _delta_texts(events) == ["x ", "y"]
    assert len(_model_runs(events)) == 1


def test_graph_message_stream_has_each_delta_once():
    from langchain.agents import create_agent

    agent = create_agent(
        model=FallbackChatModel(primary=WordFake(calls=[], bound=[]), fallback_factory=lambda: None),
        tools=[],
    )

    async def go():
        out = []
        async for chunk, _meta in agent.astream({"messages": [HumanMessage(content="hi")]}, stream_mode="messages"):
            if isinstance(chunk, AIMessageChunk) and chunk.content:
                out.append(chunk.content)
        return out

    assert asyncio.run(go()) == ["alpha ", "beta ", "gamma"]


def test_both_providers_failing_names_both_stages_without_secrets():
    class Leaky(FakeProvider):
        def _generate(self, *a, **k):
            raise RuntimeError("secret-token-123")

        def _stream(self, *a, **k):
            raise RuntimeError("secret-token-123")
            yield  # pragma: no cover

    m = FallbackChatModel(primary=Leaky(calls=[], bound=[]), fallback_factory=lambda: Leaky(calls=[], bound=[]))
    for call in (lambda: m.invoke([HumanMessage(content="hi")]), lambda: list(m.stream([HumanMessage(content="hi")]))):
        with pytest.raises(model_mod.ModelFailure) as e:
            call()
        text = str(e.value)
        assert "Bedrock primary (RuntimeError)" in text and "Vertex fallback (RuntimeError)" in text
        assert "secret-token-123" not in text
    with pytest.raises(model_mod.ModelFailure):
        asyncio.run(m.ainvoke([HumanMessage(content="hi")]))
