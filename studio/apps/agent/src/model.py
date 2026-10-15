"""Chat model factory: Bedrock primary, Vertex Gemini fallback only.

Credentials come from the standard AWS / GCP environment chains (never read or
logged here). Fallback runs only when the primary call raises, and each switch
is logged with the served model id (id only, never message content).
"""

import base64
import json
import logging
import os
from typing import Any, Callable, Iterator, AsyncIterator

from langchain_core.language_models.chat_models import BaseChatModel
from langchain_core.messages import AIMessageChunk
from langchain_core.outputs import ChatGeneration, ChatGenerationChunk, ChatResult

logger = logging.getLogger("agent.model")

DEFAULT_BEDROCK_REGION = "ap-south-1"
DEFAULT_VERTEX_LOCATION = "asia-northeast1"

# Widget generation routinely needs tens of thousands of output tokens; a small
# default truncates generateSandboxedUi args mid-stream.
MAX_TOKENS = 64000

# Named Bedrock models -> env var holding the full model id (no aliases).
BEDROCK_MODEL_ENV = {
    "sonnet": "BEDROCK_MODEL_SONNET",
    "haiku": "BEDROCK_MODEL_HAIKU",
}


def served_model_id(message) -> str | None:
    """Model id the provider reports having served, from response metadata."""
    meta = getattr(message, "response_metadata", None) or {}
    value = meta.get("model_name") or meta.get("model_id") or meta.get("model")
    return value if isinstance(value, str) else None


class FederationError(RuntimeError):
    """A federation stage failed. Messages name the stage and exception class only,
    never keys, tokens, or provider response bodies."""


GCP_SCOPES = ["https://www.googleapis.com/auth/cloud-platform"]
SESSION_SECONDS = 3600
RENEW_BEFORE_SECONDS = 300


def _load_sa_info() -> dict:
    raw = os.environ.get("GCP_SA_KEY_JSON", "").strip()
    path = os.environ.get("GCP_SA_KEY_FILE", "").strip()
    try:
        if raw:
            text = raw if raw.startswith("{") else base64.b64decode(raw, validate=True).decode("utf-8")
        elif path:
            with open(path, encoding="utf-8") as handle:
                text = handle.read()
        else:
            raise ValueError("GCP_SA_KEY_JSON or GCP_SA_KEY_FILE is required for BEDROCK_AUTH=gcp-federation.")
        info = json.loads(text)
        if not isinstance(info, dict) or not info.get("client_email"):
            raise ValueError("service account key is missing client_email")
    except ValueError as exc:
        if str(exc).startswith("GCP_SA_KEY"):
            raise
        raise ValueError("GCP service account key is not valid JSON (raw or base64).") from None
    except OSError:
        raise ValueError("GCP_SA_KEY_FILE could not be read.") from None
    return info


def mint_id_token(info: dict, audience: str | None) -> str:
    """SA key -> impersonate the SA itself -> Google ID token (include_email)."""
    try:
        from google.auth import impersonated_credentials
        from google.auth.transport.requests import Request
        from google.oauth2 import service_account

        source = service_account.Credentials.from_service_account_info(info, scopes=GCP_SCOPES)
        target = impersonated_credentials.Credentials(
            source_credentials=source,
            target_principal=info["client_email"],
            target_scopes=GCP_SCOPES,
        )
        id_creds = impersonated_credentials.IDTokenCredentials(
            target,
            target_audience=audience or info["client_email"],
            include_email=True,
        )
        id_creds.refresh(Request())
        return id_creds.token
    except Exception as exc:
        raise FederationError(f"GCP ID token minting failed ({type(exc).__name__}).") from None


def assume_role_with_token(token: str, role_arn: str, region: str) -> dict:
    """AWS STS AssumeRoleWithWebIdentity; returns botocore refresh metadata."""
    try:
        import boto3
        from botocore import UNSIGNED
        from botocore.config import Config

        sts = boto3.client("sts", region_name=region, config=Config(signature_version=UNSIGNED))
        out = sts.assume_role_with_web_identity(
            RoleArn=role_arn,
            RoleSessionName="even-studio-agent",
            WebIdentityToken=token,
            DurationSeconds=SESSION_SECONDS,
        )["Credentials"]
        return {
            "access_key": out["AccessKeyId"],
            "secret_key": out["SecretAccessKey"],
            "token": out["SessionToken"],
            "expiry_time": out["Expiration"].isoformat(),
        }
    except Exception as exc:
        raise FederationError(f"AWS STS AssumeRoleWithWebIdentity failed ({type(exc).__name__}).") from None


def federated_bedrock_client(region: str):
    """bedrock-runtime client whose credentials refresh themselves (no network until first use)."""
    import boto3
    import botocore.session
    from botocore.credentials import DeferredRefreshableCredentials

    info = _load_sa_info()
    role_arn = os.environ.get("AWS_ROLE_ARN", "").strip()
    if not role_arn:
        raise ValueError("AWS_ROLE_ARN is required for BEDROCK_AUTH=gcp-federation.")
    audience = os.environ.get("GCP_AUDIENCE", "").strip() or None

    def refresh() -> dict:
        return assume_role_with_token(mint_id_token(info, audience), role_arn, region)

    class _Credentials(DeferredRefreshableCredentials):
        # Renew 5 minutes before the 1 h session expires.
        _advisory_refresh_timeout = RENEW_BEFORE_SECONDS
        _mandatory_refresh_timeout = RENEW_BEFORE_SECONDS

    core = botocore.session.get_session()
    core._credentials = _Credentials(refresh, method="gcp-federation")
    return boto3.Session(botocore_session=core, region_name=region).client("bedrock-runtime")


def build_bedrock(name: str = "sonnet") -> BaseChatModel:
    env_name = BEDROCK_MODEL_ENV.get(name)
    if env_name is None:
        raise ValueError(f"Unknown model name {name!r}; expected one of {sorted(BEDROCK_MODEL_ENV)}.")
    model_id = os.environ.get(env_name, "").strip()
    if not model_id:
        raise ValueError(f"{env_name} is required (full Bedrock model id). Set it in the agent environment.")
    region = os.environ.get("BEDROCK_REGION", "").strip() or DEFAULT_BEDROCK_REGION
    auth = os.environ.get("BEDROCK_AUTH", "").strip() or "gcp-federation"
    if auth not in ("gcp-federation", "default-chain"):
        raise ValueError("BEDROCK_AUTH must be 'gcp-federation' or 'default-chain'.")
    from langchain_aws import ChatBedrockConverse

    options: dict = {}
    if auth == "gcp-federation":
        options["client"] = federated_bedrock_client(region)
    # Claude 5.x on Bedrock rejects temperature (and top_p/top_k): never set them.
    return ChatBedrockConverse(
        model_id=model_id,
        region_name=region,
        max_tokens=MAX_TOKENS,
        # Widget args must stream; langchain-aws otherwise downgrades ids it has not verified.
        disable_streaming=False,
        **options,
    )


def build_vertex() -> BaseChatModel | None:
    """Vertex Gemini fallback; None when VERTEX_MODEL is not configured."""
    model = os.environ.get("VERTEX_MODEL", "").strip()
    if not model:
        return None
    from langchain_google_genai import ChatGoogleGenerativeAI

    return ChatGoogleGenerativeAI(
        model=model,
        vertexai=True,
        location=os.environ.get("VERTEX_LOCATION", "").strip() or DEFAULT_VERTEX_LOCATION,
        max_output_tokens=MAX_TOKENS,
    )


class UnconfiguredModel(BaseChatModel):
    """Lets the graph compile (and `import main` succeed) with no cloud env set."""

    @property
    def _llm_type(self):
        return "unconfigured"

    def _generate(self, *args, **kwargs):
        raise ValueError(
            "No model configured. Set BEDROCK_MODEL_SONNET (and AWS credentials) in the agent environment."
        )

    def bind_tools(self, tools, **kwargs):
        return self


class ModelFailure(RuntimeError):
    """Both providers failed. Names the stages and exception classes only (no secrets)."""


def _split(model):
    """Unwrap RunnableBinding (from bind_tools) into (BaseChatModel, bound kwargs)."""
    kwargs: dict = {}
    while hasattr(model, "bound") and hasattr(model, "kwargs"):
        kwargs = {**model.kwargs, **kwargs}
        model = model.bound
    return model, kwargs


class FallbackChatModel(BaseChatModel):
    """Call `primary`; on error (before any output) retry once on the lazily built fallback.

    The inner providers are driven through their private `_generate/_stream` hooks with
    no run manager, so LangGraph/AG-UI see exactly ONE chat-model run (this one) and
    every delta is emitted once. Calling the inner Runnable API instead would open a
    second run and double every streamed token.
    """

    primary: Any
    fallback_factory: Callable[[], Any] | None = None
    tools: list | None = None
    tool_kwargs: dict = {}
    label: str = "sonnet"

    @property
    def _llm_type(self):
        return "bedrock-with-vertex-fallback"

    def bind_tools(self, tools, **kwargs):
        return self.model_copy(
            update={
                "primary": self.primary.bind_tools(tools, **kwargs),
                "tools": list(tools),
                "tool_kwargs": dict(kwargs),
            }
        )

    def _fallback(self):
        if self.fallback_factory is None:
            return None
        model = self.fallback_factory()
        if model is not None and self.tools is not None:
            model = model.bind_tools(self.tools, **self.tool_kwargs)
        return model

    def _log_failure(self, exc: Exception, have_fallback: bool):
        logger.warning(
            "primary model %s failed (%s); %s",
            self.label,
            type(exc).__name__,
            "using Vertex fallback" if have_fallback else "no fallback configured",
        )

    def _log_served(self, message, route: str):
        logger.info("served model id=%s route=%s", served_model_id(message) or "unknown", route)

    def _both_failed(self, primary_exc: Exception, fallback_exc: Exception) -> ModelFailure:
        return ModelFailure(
            f"Model request failed on both providers: Bedrock primary ({type(primary_exc).__name__}); "
            f"Vertex fallback ({type(fallback_exc).__name__})."
        )

    # -- sync -----------------------------------------------------------
    def _generate(self, messages, stop=None, run_manager=None, **kwargs):
        base, bound = _split(self.primary)
        try:
            result = base._generate(messages, stop=stop, run_manager=None, **{**bound, **kwargs})
            self._log_served(result.generations[0].message, "primary")
            return result
        except Exception as exc:
            fallback = self._fallback()
            self._log_failure(exc, fallback is not None)
            if fallback is None:
                raise
            fb, fb_bound = _split(fallback)
            try:
                result = fb._generate(messages, stop=stop, run_manager=None, **{**fb_bound, **kwargs})
            except Exception as fb_exc:
                raise self._both_failed(exc, fb_exc) from None
            self._log_served(result.generations[0].message, "fallback")
            return result

    async def _agenerate(self, messages, stop=None, run_manager=None, **kwargs):
        base, bound = _split(self.primary)
        try:
            result = await base._agenerate(messages, stop=stop, run_manager=None, **{**bound, **kwargs})
            self._log_served(result.generations[0].message, "primary")
            return result
        except Exception as exc:
            fallback = self._fallback()
            self._log_failure(exc, fallback is not None)
            if fallback is None:
                raise
            fb, fb_bound = _split(fallback)
            try:
                result = await fb._agenerate(messages, stop=stop, run_manager=None, **{**fb_bound, **kwargs})
            except Exception as fb_exc:
                raise self._both_failed(exc, fb_exc) from None
            self._log_served(result.generations[0].message, "fallback")
            return result

    def _stream(self, messages, stop=None, run_manager=None, **kwargs) -> Iterator[ChatGenerationChunk]:
        base, bound = _split(self.primary)
        emitted = False
        primary_exc: Exception | None = None
        try:
            for chunk in base._stream(messages, stop=stop, run_manager=None, **{**bound, **kwargs}):
                emitted = True
                if served_model_id(chunk.message):
                    self._log_served(chunk.message, "primary")
                yield chunk
            return
        except Exception as exc:
            primary_exc = exc
            fallback = self._fallback()
            # Never splice two providers into one partially streamed answer.
            self._log_failure(exc, fallback is not None and not emitted)
            if fallback is None or emitted:
                raise
        fb, fb_bound = _split(fallback)
        try:
            for chunk in fb._stream(messages, stop=stop, run_manager=None, **{**fb_bound, **kwargs}):
                if served_model_id(chunk.message):
                    self._log_served(chunk.message, "fallback")
                yield chunk
        except Exception as fb_exc:
            raise self._both_failed(primary_exc, fb_exc) from None

    async def _astream(self, messages, stop=None, run_manager=None, **kwargs) -> AsyncIterator[ChatGenerationChunk]:
        base, bound = _split(self.primary)
        emitted = False
        primary_exc: Exception | None = None
        try:
            async for chunk in base._astream(messages, stop=stop, run_manager=None, **{**bound, **kwargs}):
                emitted = True
                if served_model_id(chunk.message):
                    self._log_served(chunk.message, "primary")
                yield chunk
            return
        except Exception as exc:
            primary_exc = exc
            fallback = self._fallback()
            self._log_failure(exc, fallback is not None and not emitted)
            if fallback is None or emitted:
                raise
        fb, fb_bound = _split(fallback)
        try:
            async for chunk in fb._astream(messages, stop=stop, run_manager=None, **{**fb_bound, **kwargs}):
                if served_model_id(chunk.message):
                    self._log_served(chunk.message, "fallback")
                yield chunk
        except Exception as fb_exc:
            raise self._both_failed(primary_exc, fb_exc) from None


def as_chunk(message):
    if isinstance(message, AIMessageChunk):
        return message
    return AIMessageChunk(**message.model_dump(exclude={"type"}))


def build_model(name: str = "sonnet", *, allow_unconfigured: bool = False) -> BaseChatModel:
    """Named model ("sonnet" for the agent, "haiku" as the second) with Vertex fallback."""
    try:
        primary = build_bedrock(name)
    except ValueError:
        if allow_unconfigured:
            return UnconfiguredModel()
        raise
    return FallbackChatModel(primary=primary, fallback_factory=build_vertex, label=name)
