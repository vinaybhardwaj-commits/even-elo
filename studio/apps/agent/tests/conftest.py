import pytest


@pytest.fixture(autouse=True)
def _clean_studio_env(monkeypatch):
    """Studio env never leaks between tests (or in from the host)."""
    for name in (
        "STUDIO_LIVE_READS",
        "STUDIO_DATABASE_URL",
        "GOV_RO_DATABASE_URL",
        "STUDIO_SERVICE_TOKEN",
        "STUDIO_ACTOR_SECRET",
        "STUDIO_RATE_PER_MIN",
        "STUDIO_LOG_LEVEL",
    ):
        monkeypatch.delenv(name, raising=False)


@pytest.fixture
def anyio_backend():
    return "asyncio"
