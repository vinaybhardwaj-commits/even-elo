from datetime import datetime, timezone

from langchain.agents.middleware import ModelRequest
from langchain_core.messages import HumanMessage, SystemMessage

from src.clock import CurrentTimeMiddleware, clock_note, with_clock


def _request(content="base"):
    return ModelRequest(model=None, messages=[HumanMessage(content="How many incidents in the last 30 days?")], tools=[], system_message=SystemMessage(content=content), state={})


def test_note_gives_kolkata_date_and_a_concrete_last_30_days_range():
    # 20:00 UTC on 21 Oct is 01:30 on 22 Oct in Kolkata: the IST calendar day wins.
    note = clock_note(datetime(2026, 10, 21, 20, 0, tzinfo=timezone.utc))
    assert "Current date: Thursday 22 October 2026 Asia/Kolkata" in note
    assert "today is 2026-10-22" in note
    assert "since=2026-09-23, until=2026-10-22" in note


def test_every_model_call_gets_the_clock_appended_to_the_system_message():
    seen = []
    CurrentTimeMiddleware().wrap_model_call(_request(), lambda r: seen.append(r.system_message.content))
    assert seen[0].startswith("base\n\nCurrent date: ")
    blocks = with_clock(_request([{"type": "text", "text": "base"}]), datetime(2026, 1, 1, tzinfo=timezone.utc)).system_message.content
    assert blocks[0] == {"type": "text", "text": "base"}
    assert "today is 2026-01-01" in blocks[1]["text"]


def test_agent_wires_the_clock_middleware():
    import main

    graph_middleware = main.build_agent.__code__.co_names
    assert "CurrentTimeMiddleware" in graph_middleware


def test_note_is_the_same_all_day_so_the_prompt_cache_survives():
    # 00:00 and 23:59 IST on 22 Oct: one note (no time of day); the next IST day gives a new one.
    start = clock_note(datetime(2026, 10, 21, 18, 30, tzinfo=timezone.utc))
    assert clock_note(datetime(2026, 10, 22, 18, 29, tzinfo=timezone.utc)) == start
    assert clock_note(datetime(2026, 10, 22, 18, 30, tzinfo=timezone.utc)) != start
    assert ":" not in start.split("Current date:")[1].split("(IST")[0]
