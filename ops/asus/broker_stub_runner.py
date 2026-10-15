"""Test-only runner (used by test-asus-container.sh): the REAL broker code with a stub federation, listening on a tailnet-range
address (100.100.0.5, a secondary address on the stub container). Usage: broker_stub_runner.py LISTEN_IP PORT ALLOWED_SOURCE TOKEN"""
import sys

sys.path.insert(0, "/opt/broker-test")
import broker  # noqa: E402

ip, port, allowed, token = sys.argv[1:5]
cfg = broker.load_config({
    "BROKER_LISTEN": f"{ip}:{port}", "BROKER_TOKEN": token, "BROKER_ALLOWED_SOURCES": allowed,
    "BROKER_ROLE_ARN": "arn:aws:iam::123456789012:role/GCPBedrockRole", "BROKER_GCP_SA_KEY_FILE": "/nonexistent",
    "BROKER_MODEL_IDS": "global.anthropic.claude-sonnet-5-5,global.anthropic.claude-haiku-5-5",
})


def stub_federation(_cfg):
    return {"AccessKeyId": "ASIASTUBKEY", "SecretAccessKey": "stub-secret", "SessionToken": "stub-session-token", "Expiration": 4102444800}


srv = broker.serve(cfg, stub_federation, require_tailnet=True)  # the stub sits on a tailnet-range address, like t4
print("stub broker listening", flush=True)
srv.serve_forever()
