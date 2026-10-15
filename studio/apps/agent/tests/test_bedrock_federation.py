"""GCP-federated Bedrock auth with Google and STS mocked. No network, no real keys."""

import base64
import datetime as dt
import json
import sys
import types

import pytest

import src.model as m

SECRET_KEY_MATERIAL = "-----BEGIN PRIVATE KEY-----FAKE-----END PRIVATE KEY-----"
SA = {"client_email": "svc@proj.iam.gserviceaccount.com", "private_key": SECRET_KEY_MATERIAL, "type": "service_account"}
ROLE = "arn:aws:iam::123456789012:role/test-role"


@pytest.fixture(autouse=True)
def env(monkeypatch):
    for n in ("BEDROCK_AUTH", "GCP_SA_KEY_JSON", "GCP_SA_KEY_FILE", "GCP_AUDIENCE", "AWS_ROLE_ARN", "BEDROCK_REGION"):
        monkeypatch.delenv(n, raising=False)
    monkeypatch.setenv("BEDROCK_MODEL_SONNET", "global.anthropic.claude-sonnet-5-5")


# ---- key loading -----------------------------------------------------------

def test_key_loads_raw_json_base64_and_file(monkeypatch, tmp_path):
    monkeypatch.setenv("GCP_SA_KEY_JSON", json.dumps(SA))
    assert m._load_sa_info()["client_email"] == SA["client_email"]
    monkeypatch.setenv("GCP_SA_KEY_JSON", base64.b64encode(json.dumps(SA).encode()).decode())
    assert m._load_sa_info()["client_email"] == SA["client_email"]
    monkeypatch.delenv("GCP_SA_KEY_JSON")
    f = tmp_path / "k.json"
    f.write_text(json.dumps(SA))
    monkeypatch.setenv("GCP_SA_KEY_FILE", str(f))
    assert m._load_sa_info()["client_email"] == SA["client_email"]


def test_key_errors_never_echo_contents(monkeypatch):
    monkeypatch.setenv("GCP_SA_KEY_JSON", "{not json " + SECRET_KEY_MATERIAL)
    with pytest.raises(ValueError) as e:
        m._load_sa_info()
    assert "PRIVATE KEY" not in str(e.value) and "FAKE" not in str(e.value)
    monkeypatch.delenv("GCP_SA_KEY_JSON")
    with pytest.raises(ValueError, match="GCP_SA_KEY_JSON or GCP_SA_KEY_FILE"):
        m._load_sa_info()
    monkeypatch.setenv("GCP_SA_KEY_FILE", "/nonexistent/key.json")
    with pytest.raises(ValueError, match="could not be read"):
        m._load_sa_info()


# ---- Google ID token -------------------------------------------------------

def fake_google(monkeypatch, record, fail=False):
    class Source:
        @classmethod
        def from_service_account_info(cls, info, scopes):
            record["source"] = (info["client_email"], scopes)
            return cls()

    class Imp:
        def __init__(self, source_credentials, target_principal, target_scopes):
            record["impersonate"] = target_principal

    class IdTok:
        token = None

        def __init__(self, target, target_audience, include_email):
            record["audience"], record["include_email"] = target_audience, include_email

        def refresh(self, request):
            if fail:
                raise RuntimeError("leaky " + SECRET_KEY_MATERIAL)
            self.token = "id-token-value"

    imp = types.SimpleNamespace(Credentials=Imp, IDTokenCredentials=IdTok)
    monkeypatch.setattr("google.auth.impersonated_credentials.Credentials", Imp)
    monkeypatch.setattr("google.auth.impersonated_credentials.IDTokenCredentials", IdTok)
    monkeypatch.setattr("google.oauth2.service_account.Credentials", Source)
    monkeypatch.setattr("google.auth.transport.requests.Request", lambda: object())
    return imp


def test_id_token_uses_audience_then_sa_email(monkeypatch):
    rec = {}
    fake_google(monkeypatch, rec)
    assert m.mint_id_token(SA, "my-aud") == "id-token-value"
    assert rec["audience"] == "my-aud" and rec["include_email"] is True
    assert rec["impersonate"] == SA["client_email"]  # impersonates the SA itself
    m.mint_id_token(SA, None)
    assert rec["audience"] == SA["client_email"]


def test_id_token_errors_are_scrubbed(monkeypatch):
    fake_google(monkeypatch, {}, fail=True)
    with pytest.raises(m.FederationError) as e:
        m.mint_id_token(SA, "aud")
    assert "PRIVATE KEY" not in str(e.value) and "leaky" not in str(e.value)
    assert "RuntimeError" in str(e.value)


# ---- STS -------------------------------------------------------------------

class FakeSts:
    def __init__(self, record, fail=False):
        self.record, self.fail = record, fail

    def assume_role_with_web_identity(self, **kw):
        self.record.update(kw)
        if self.fail:
            raise RuntimeError("token web-id-secret rejected")
        return {"Credentials": {
            "AccessKeyId": "AKIATEST", "SecretAccessKey": "sk", "SessionToken": "st",
            "Expiration": dt.datetime(2030, 1, 1, tzinfo=dt.timezone.utc),
        }}


def test_assume_role_call_shape(monkeypatch):
    rec = {}
    seen = {}

    def client(name, **kw):
        seen["svc"], seen["region"] = name, kw["region_name"]
        return FakeSts(rec)

    monkeypatch.setattr("boto3.client", client)
    meta = m.assume_role_with_token("tok", ROLE, "ap-south-1")
    assert seen == {"svc": "sts", "region": "ap-south-1"}
    assert rec["RoleArn"] == ROLE and rec["WebIdentityToken"] == "tok" and rec["DurationSeconds"] == 3600
    assert meta["access_key"] == "AKIATEST" and meta["expiry_time"].startswith("2030-01-01")


def test_sts_errors_are_scrubbed(monkeypatch):
    monkeypatch.setattr("boto3.client", lambda *a, **k: FakeSts({}, fail=True))
    with pytest.raises(m.FederationError) as e:
        m.assume_role_with_token("web-id-secret", ROLE, "ap-south-1")
    assert "web-id-secret" not in str(e.value)


# ---- refreshing credentials ------------------------------------------------

def test_credentials_are_lazy_assume_role_and_renew_before_expiry(monkeypatch):
    monkeypatch.setenv("GCP_SA_KEY_JSON", json.dumps(SA))
    monkeypatch.setenv("AWS_ROLE_ARN", ROLE)
    monkeypatch.setenv("GCP_AUDIENCE", "aud-1")
    mints, assumes = [], []
    monkeypatch.setattr(m, "mint_id_token", lambda info, aud: mints.append(aud) or "tok")
    now = dt.datetime.now(dt.timezone.utc)
    expiries = [now + dt.timedelta(hours=1), now + dt.timedelta(seconds=200), now + dt.timedelta(hours=1)]

    def assume(token, role, region):
        assumes.append((token, role, region))
        return {"access_key": f"AK{len(assumes)}", "secret_key": "s", "token": "t",
                "expiry_time": expiries[len(assumes) - 1].isoformat()}

    monkeypatch.setattr(m, "assume_role_with_token", assume)
    client = m.federated_bedrock_client("ap-south-1")
    assert mints == [] and assumes == []  # nothing happens at construction
    creds = client._request_signer._credentials
    first = creds.get_frozen_credentials()
    assert first.access_key == "AK1" and mints == ["aud-1"]
    assert assumes == [("tok", ROLE, "ap-south-1")]
    creds.get_frozen_credentials()
    assert len(assumes) == 1  # still valid, no refresh
    creds._expiry_time = now + dt.timedelta(seconds=200)  # inside the 5 min window
    assert creds.get_frozen_credentials().access_key == "AK2"
    assert len(assumes) == 2


def test_federation_config_errors(monkeypatch):
    monkeypatch.setenv("GCP_SA_KEY_JSON", json.dumps(SA))
    with pytest.raises(ValueError, match="AWS_ROLE_ARN"):
        m.federated_bedrock_client("ap-south-1")
    monkeypatch.setenv("BEDROCK_AUTH", "bogus")
    with pytest.raises(ValueError, match="BEDROCK_AUTH"):
        m.build_bedrock("sonnet")


# ---- build + request shape ---------------------------------------------------

def test_default_mode_is_federation_and_passes_client(monkeypatch):
    seen = {}
    sentinel = object()
    monkeypatch.setattr(m, "federated_bedrock_client", lambda region: sentinel)

    class Fake:
        def __init__(self, **kw):
            seen.update(kw)

    monkeypatch.setattr("langchain_aws.ChatBedrockConverse", Fake)
    m.build_bedrock("sonnet")
    assert seen["client"] is sentinel
    assert seen["model_id"] == "global.anthropic.claude-sonnet-5-5"
    for banned in ("temperature", "top_p", "top_k"):
        assert banned not in seen


def test_default_chain_does_not_use_federation(monkeypatch):
    monkeypatch.setenv("BEDROCK_AUTH", "default-chain")
    monkeypatch.setattr(m, "federated_bedrock_client", lambda region: pytest.fail("must not federate"))
    seen = {}

    class Fake:
        def __init__(self, **kw):
            seen.update(kw)

    monkeypatch.setattr("langchain_aws.ChatBedrockConverse", Fake)
    m.build_bedrock("sonnet")
    assert "client" not in seen


def test_converse_request_has_no_sampling_params():
    from langchain_aws import ChatBedrockConverse
    from langchain_core.messages import HumanMessage

    sent = {}

    class StubClient:
        meta = types.SimpleNamespace(region_name="ap-south-1")

        def converse(self, **kw):
            sent.update(kw)
            return {"output": {"message": {"role": "assistant", "content": [{"text": "ok"}]}},
                    "stopReason": "end_turn", "usage": {"inputTokens": 1, "outputTokens": 1, "totalTokens": 2},
                    "metrics": {"latencyMs": 1}}

    llm = ChatBedrockConverse(model_id="global.anthropic.claude-sonnet-5-5", region_name="ap-south-1",
                              max_tokens=1000, client=StubClient(), disable_streaming=True)
    llm.invoke([HumanMessage(content="hi")])
    cfg = sent.get("inferenceConfig", {})
    for banned in ("temperature", "topP", "top_p", "topK", "top_k"):
        assert banned not in cfg and banned not in sent
        assert banned not in sent.get("additionalModelRequestFields", {})
    assert cfg.get("maxTokens") == 1000
