"""Offline tests for the credential broker (stdlib only, no network, no AWS/GCP)."""
import json
import threading
import unittest
import urllib.error
import urllib.request

import broker

ROLE = "arn:aws:iam::123456789012:role/GCPBedrockRole"
MODELS = ["global.anthropic.claude-sonnet-5-5", "global.anthropic.claude-haiku-5-5"]
ENV = {
    "BROKER_LISTEN": "127.0.0.1:0", "BROKER_TOKEN": "tok-123", "BROKER_ALLOWED_SOURCES": "127.0.0.1",
    "BROKER_ROLE_ARN": ROLE, "BROKER_GCP_SA_KEY_FILE": "/nonexistent", "BROKER_MODEL_IDS": ",".join(MODELS),
}


def fake_federation(cfg):
    fake_federation.calls += 1
    return {"AccessKeyId": "ASIAFAKE", "SecretAccessKey": "secret", "SessionToken": "tok", "Expiration": 4102444800}


fake_federation.calls = 0


class PolicyTests(unittest.TestCase):
    def setUp(self):
        self.p = broker.session_policy(ROLE, MODELS, "ap-south-1")

    def test_shape(self):
        st = self.p["Statement"]
        self.assertEqual(len(st), 1)
        self.assertEqual(st[0]["Effect"], "Allow")
        self.assertEqual(sorted(st[0]["Action"]), sorted(broker.ACTIONS))
        self.assertLess(len(json.dumps(self.p, separators=(",", ":"))), 2048)  # STS session policy limit (packed)

    def test_invoke_pinned_models_allowed(self):
        for mid in MODELS:
            profile = f"arn:aws:bedrock:ap-south-1:123456789012:inference-profile/{mid}"
            base = f"arn:aws:bedrock:eu-west-1::foundation-model/{mid.split('.', 1)[1]}"
            for act in broker.ACTIONS:
                self.assertTrue(broker.policy_allows(self.p, act, profile), (act, profile))
                self.assertTrue(broker.policy_allows(self.p, act, base), (act, base))

    def test_everything_else_denied(self):
        prof = f"arn:aws:bedrock:ap-south-1:123456789012:inference-profile/{MODELS[0]}"
        denied = [
            ("bedrock:ListFoundationModels", "*"), ("bedrock:GetFoundationModel", prof), ("bedrock:Converse", prof),
            ("bedrock:CreateModelCustomizationJob", "*"), ("bedrock:PutModelInvocationLoggingConfiguration", "*"),
            ("sts:AssumeRole", ROLE), ("s3:GetObject", "arn:aws:s3:::bucket/key"), ("iam:CreateUser", "*"),
            ("kms:Decrypt", "*"), ("secretsmanager:GetSecretValue", "*"),
        ]
        for act, res in denied:
            self.assertFalse(broker.policy_allows(self.p, act, res), (act, res))

    def test_other_models_and_accounts_denied(self):
        for res in (
            "arn:aws:bedrock:ap-south-1:123456789012:inference-profile/global.anthropic.claude-opus-5-5",
            "arn:aws:bedrock:ap-south-1:999999999999:inference-profile/" + MODELS[0],
            "arn:aws:bedrock:*::foundation-model/anthropic.claude-opus-5-5",
            "arn:aws:bedrock:ap-south-1::foundation-model/amazon.titan-text-express-v1",
        ):
            self.assertFalse(broker.policy_allows(self.p, "bedrock:InvokeModel", res), res)

    def test_plain_model_id(self):
        p = broker.session_policy(ROLE, ["anthropic.claude-x"], "ap-south-1")
        self.assertTrue(broker.policy_allows(p, "bedrock:InvokeModel", "arn:aws:bedrock:ap-south-1::foundation-model/anthropic.claude-x"))
        self.assertFalse(broker.policy_allows(p, "bedrock:InvokeModel", "arn:aws:bedrock:us-east-1::foundation-model/anthropic.claude-x"))


class ConfigTests(unittest.TestCase):
    def test_duration_clamped(self):
        self.assertEqual(broker.load_config({**ENV, "BROKER_DURATION": "60"})["duration"], 900)
        self.assertEqual(broker.load_config({**ENV, "BROKER_DURATION": "99999"})["duration"], 3600)
        self.assertEqual(broker.load_config({**ENV, "BROKER_DURATION": "1800"})["duration"], 1800)

    def test_missing_value(self):
        for k in ("BROKER_TOKEN", "BROKER_ROLE_ARN", "BROKER_MODEL_IDS", "BROKER_ALLOWED_SOURCES"):
            env = {kk: v for kk, v in ENV.items() if kk != k}
            with self.assertRaises(broker.ConfigError):
                broker.load_config(env)

    def test_refuses_non_tailnet_listener(self):
        cfg = broker.load_config({**ENV, "BROKER_LISTEN": "192.168.1.5:8765"})
        with self.assertRaises(broker.ConfigError):
            broker.serve(cfg)
        cfg = broker.load_config({**ENV, "BROKER_LISTEN": "0.0.0.0:8765"})
        with self.assertRaises(broker.ConfigError):
            broker.serve(cfg)
        self.assertTrue(broker.is_tailnet("100.101.102.103"))
        self.assertFalse(broker.is_tailnet("100.63.0.1"))
        self.assertTrue(broker.is_tailnet("fd7a:115c:a1e0::1"))


class HttpTests(unittest.TestCase):
    def start(self, sources="127.0.0.1"):
        fake_federation.calls = 0
        cfg = broker.load_config({**ENV, "BROKER_ALLOWED_SOURCES": sources})
        srv = broker.serve(cfg, fake_federation, require_tailnet=False)  # tests bind loopback; the CLI never does
        threading.Thread(target=srv.serve_forever, daemon=True).start()
        self.addCleanup(srv.shutdown)
        self.addCleanup(srv.server_close)
        return "http://127.0.0.1:%d" % srv.server_address[1]

    def get(self, url, token="tok-123", path="/creds", method="GET"):
        req = urllib.request.Request(url + path, method=method)
        if token is not None:
            req.add_header("Authorization", "Bearer " + token)
        try:
            with urllib.request.urlopen(req, timeout=5) as r:
                return r.status, json.loads(r.read() or b"{}")
        except urllib.error.HTTPError as e:
            return e.code, json.loads(e.read() or b"{}")

    def test_returns_credential_process_json(self):
        code, body = self.get(self.start())
        self.assertEqual(code, 200)
        self.assertEqual(body["Version"], 1)
        for k in ("AccessKeyId", "SecretAccessKey", "SessionToken", "Expiration"):
            self.assertIn(k, body)
        self.assertRegex(body["Expiration"], r"^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$")

    def test_unauthenticated_refused(self):
        url = self.start()
        self.assertEqual(self.get(url, token=None)[0], 401)
        self.assertEqual(self.get(url, token="wrong")[0], 401)
        self.assertEqual(self.get(url, token="")[0], 401)
        self.assertEqual(fake_federation.calls, 0)

    def test_non_allowed_source_refused_even_with_token(self):
        url = self.start(sources="100.64.0.7")  # the caller is 127.0.0.1
        self.assertEqual(self.get(url)[0], 403)
        self.assertEqual(fake_federation.calls, 0)

    def test_other_paths_and_methods(self):
        url = self.start()
        self.assertEqual(self.get(url, path="/other")[0], 404)
        self.assertEqual(self.get(url, method="POST")[0], 405)

    def test_cached_between_calls(self):
        url = self.start()
        self.get(url); self.get(url); self.get(url)
        self.assertEqual(fake_federation.calls, 1)

    def test_federation_error_is_opaque(self):
        def boom(cfg):
            raise RuntimeError("secret provider body")
        cfg = broker.load_config(ENV)
        srv = broker.serve(cfg, boom, require_tailnet=False)
        threading.Thread(target=srv.serve_forever, daemon=True).start()
        self.addCleanup(srv.shutdown); self.addCleanup(srv.server_close)
        code, body = self.get("http://127.0.0.1:%d" % srv.server_address[1])
        self.assertEqual(code, 502)
        self.assertNotIn("secret", json.dumps(body))


if __name__ == "__main__":
    unittest.main()
