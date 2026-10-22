"""The model has no clock: tell it the current date and time (Asia/Kolkata) on every model call, so relative
ranges such as "the last 30 days" become concrete since/until dates for the read tools."""

from datetime import datetime, timedelta
from zoneinfo import ZoneInfo

from langchain.agents.middleware import AgentMiddleware
from langchain_core.messages import SystemMessage

KOLKATA = ZoneInfo("Asia/Kolkata")


def clock_note(now: datetime | None = None) -> str:
    now = (now or datetime.now(KOLKATA)).astimezone(KOLKATA)
    today = now.date()
    return (
        f"\n\nCurrent date and time: {now:%A %d %B %Y, %H:%M} Asia/Kolkata (IST, UTC+05:30); today is {today.isoformat()}. "
        "Resolve relative periods against it and pass them to tools as dates (YYYY-MM-DD, Asia/Kolkata days, until inclusive): "
        f"for example the last 30 days is since={(today - timedelta(days=29)).isoformat()}, until={today.isoformat()}. "
        "State the dates you used in the answer."
    )


def with_clock(request, now: datetime | None = None):
    note = clock_note(now)
    content = request.system_message.content if request.system_message else ""
    if isinstance(content, list):
        content = [*content, {"type": "text", "text": note}]
    else:
        content += note
    return request.override(system_message=SystemMessage(content=content))


class CurrentTimeMiddleware(AgentMiddleware):
    def wrap_model_call(self, request, handler):
        return handler(with_clock(request))

    async def awrap_model_call(self, request, handler):
        return await handler(with_clock(request))
