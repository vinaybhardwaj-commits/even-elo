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


@pytest.fixture(autouse=True)
def _fresh_cdmss_cache():
    """The CDMSS result cache (300 s) never carries a payload from one test into the next."""
    from src import studio_cdmss_tools

    studio_cdmss_tools.clear_cache()
    yield
    studio_cdmss_tools.clear_cache()


@pytest.fixture
def anyio_backend():
    return "asyncio"


def pytest_configure(config):
    """Guard against piles of stale clusters, then arm teardown (atexit + SIGTERM) for every pgserver this run starts."""
    import importlib.util

    from tests import pg_teardown

    if importlib.util.find_spec("pgserver") is not None:
        try:
            pg_teardown.guard()
        except RuntimeError as exc:
            raise pytest.UsageError(str(exc)) from None
    pg_teardown.install_handlers()


def pytest_sessionfinish(session, exitstatus):
    from tests import pg_teardown

    pg_teardown.cleanup_all()
