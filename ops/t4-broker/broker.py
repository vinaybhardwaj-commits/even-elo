#!/usr/bin/env python3
"""Studio credential broker (runs on t4, tailnet only).

Holds the GCP service-account key and does the GCP -> AWS federation the Asus agent used to do itself:
  SA key -> impersonate the SA -> Google ID token -> STS AssumeRoleWithWebIdentity
and returns short-lived AWS credentials in `credential_process` format. The credentials carry a SESSION POLICY that
allows only bedrock:InvokeModel / InvokeModelWithResponseStream on the two pinned model ids, so a stolen set of
credentials can do nothing else, whatever the role itself allows.

Client auth: the caller's source address must be one of BROKER_ALLOWED_SOURCES (single IPs, never a range: the Asus tailnet
IP) AND it must present the bearer token BROKER_TOKEN. The listener refuses to start on a non-tailnet address, serves at most
BROKER_MAX_CONNECTIONS (32) connections at a time and drops a connection that stays silent for BROKER_READ_TIMEOUT (10) seconds.

Nothing secret is logged: only the caller address, the outcome and the credential expiry.
Standard library only at import time; google-auth / boto3 are imported when a federation is actually performed.
"""
import fnmatch
import hmac
import ipaddress
import json
import os
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

TAILNET_V4 = ipaddress.ip_network("100.64.0.0/10")
TAILNET_V6 = ipaddress.ip_network("fd7a:115c:a1e0::/48")
ACTIONS = ("bedrock:InvokeModel", "bedrock:InvokeModelWithResponseStream")
MIN_DURATION, MAX_DURATION = 900, 3600
REFRESH_MARGIN = 600  # re-federate when the cached credentials have less than this left


class ConfigError(Exception):
    pass


def is_tailnet(addr: str) -> bool:
    ip = ipaddress.ip_address(addr)
    return ip in TAILNET_V4 or ip in TAILNET_V6


def parse_sources(text: str):
    """Single addresses only: a bare IPv4/IPv6 address or an explicit /32 (/128). A range such as 100.64.0.0/10 would admit
    every tailnet node that ever obtains the token, so it is refused."""
    out = []
    for raw in text.split(","):
        raw = raw.strip()
        if not raw:
            continue
        net = ipaddress.ip_network(raw, strict=False)
        if net.prefixlen != net.max_prefixlen:
            raise ConfigError(f"BROKER_ALLOWED_SOURCES must list single IP addresses, not the range {raw}")
        out.append(net)
    if not out:
        raise ConfigError("BROKER_ALLOWED_SOURCES is empty")
    return out


def load_config(env=None) -> dict:
    env = os.environ if env is None else env
    def need(name):
        v = env.get(name, "").strip()
        if not v:
            raise ConfigError(f"{name} is required")
        return v
    host, _, port = need("BROKER_LISTEN").rpartition(":")
    if not host or not port.isdigit():
        raise ConfigError("BROKER_LISTEN must be IP:PORT")
    models = [m.strip() for m in need("BROKER_MODEL_IDS").split(",") if m.strip()]
    if not models:
        raise ConfigError("BROKER_MODEL_IDS is empty")
    sources = parse_sources(need("BROKER_ALLOWED_SOURCES"))
    duration = int(env.get("BROKER_DURATION", "3600"))
    return {
        "listen": (host.strip("[]"), int(port)),
        "token": need("BROKER_TOKEN"),
        "sources": sources,
        "role_arn": need("BROKER_ROLE_ARN"),
        "audience": env.get("BROKER_GCP_AUDIENCE", "").strip() or None,
        "key_file": need("BROKER_GCP_SA_KEY_FILE"),
        "region": env.get("BROKER_AWS_REGION", "ap-south-1").strip(),
        "models": models,
        "duration": max(MIN_DURATION, min(MAX_DURATION, duration)),
        "max_connections": max(1, int(env.get("BROKER_MAX_CONNECTIONS", "32"))),
        "read_timeout": max(1.0, float(env.get("BROKER_READ_TIMEOUT", "10"))),
    }


# ----------------------------------------------------------------------------- session policy
def model_resources(role_arn: str, model_ids, region: str):
    """ARNs the pinned model ids can be invoked through. A geo/global inference profile id
    ('global.anthropic.x') needs the profile ARN in the role's account AND the underlying foundation-model ARN
    (any region, the profile routes). A plain model id needs only the foundation-model ARN in the region."""
    account = role_arn.split(":")[4]
    out = []
    for mid in model_ids:
        head, _, rest = mid.partition(".")
        if head in ("global", "us", "eu", "apac", "jp", "au", "ca", "us-gov") and rest:
            out.append(f"arn:aws:bedrock:{region}:{account}:inference-profile/{mid}")
            out.append(f"arn:aws:bedrock:*::foundation-model/{rest}")
        else:
            out.append(f"arn:aws:bedrock:{region}::foundation-model/{mid}")
    return sorted(set(out))


def global_model_resources(model_ids):
    """Region-less foundation-model ARNs for 'global.*' profiles. AWS authorizes the global profile's model against
    arn:aws:bedrock:::foundation-model/<model> with aws:RequestedRegion = 'unspecified' (live denial 15 Oct showed exactly this
    ARN), so these get their own statement; they are only reachable through the global profile allowed in statement one."""
    out = []
    for mid in model_ids:
        head, _, rest = mid.partition(".")
        if head == "global" and rest:
            out.append(f"arn:aws:bedrock:::foundation-model/{rest}")
    return sorted(set(out))


def session_policy(role_arn: str, model_ids, region: str) -> dict:
    """aws:RequestedRegion is the region of the API ENDPOINT that receives the call, so statement one pins the inference
    profile (and the regional model ARNs) to ap-south-1: stolen credentials cannot call bedrock-runtime in any other region.
    For a 'global.*' profile AWS also checks the region-less model ARN with aws:RequestedRegion = 'unspecified'; statement
    two allows exactly those ARNs and nothing else (no profile, no regional model)."""
    statements = [{
        "Sid": "InvokePinnedModelsOnly",
        "Effect": "Allow",
        "Action": list(ACTIONS),
        "Resource": model_resources(role_arn, model_ids, region),
        "Condition": {"StringEquals": {"aws:RequestedRegion": region}},
    }]
    glob = global_model_resources(model_ids)
    if glob:
        statements.append({
            "Sid": "GlobalProfileModelsOnly",
            "Effect": "Allow",
            "Action": list(ACTIONS),
            "Resource": glob,
            "Condition": {"StringEquals": {"aws:RequestedRegion": "unspecified"}},
        })
    return {"Version": "2012-10-17", "Statement": statements}


def policy_allows(policy: dict, action: str, resource: str, context=None) -> bool:
    """Minimal IAM evaluation of an identity-style policy (Allow/Deny statements with wildcard Action/Resource, StringEquals
    conditions on the keys in `context`, no NotAction). A condition key that is absent from the context fails the condition.
    A session policy only ever restricts the role, so 'allowed here' is necessary, not sufficient."""
    context = context or {}
    allowed = False
    for st in policy.get("Statement", []):
        cond = st.get("Condition", {}).get("StringEquals", {})
        if any(context.get(k) != v for k, v in cond.items()):
            continue
        acts = st["Action"] if isinstance(st["Action"], list) else [st["Action"]]
        res = st["Resource"] if isinstance(st["Resource"], list) else [st["Resource"]]
        hit = any(fnmatch.fnmatchcase(action.lower(), a.lower()) for a in acts) and any(fnmatch.fnmatchcase(resource, r) for r in res)
        if hit and st["Effect"] == "Deny":
            return False
        if hit and st["Effect"] == "Allow":
            allowed = True
    return allowed


# ----------------------------------------------------------------------------- federation (real)
def federate(cfg: dict) -> dict:
    """Return {'AccessKeyId','SecretAccessKey','SessionToken','Expiration'(datetime)} for the session policy above."""
    import boto3
    from botocore import UNSIGNED
    from botocore.config import Config
    from google.auth import impersonated_credentials
    from google.auth.transport.requests import Request
    from google.oauth2 import service_account

    scopes = ["https://www.googleapis.com/auth/cloud-platform"]
    with open(cfg["key_file"], encoding="utf-8") as f:
        info = json.load(f)
    source = service_account.Credentials.from_service_account_info(info, scopes=scopes)
    target = impersonated_credentials.Credentials(source_credentials=source, target_principal=info["client_email"], target_scopes=scopes)
    id_creds = impersonated_credentials.IDTokenCredentials(target, target_audience=cfg["audience"] or info["client_email"], include_email=True)
    id_creds.refresh(Request())
    sts = boto3.client("sts", region_name=cfg["region"], config=Config(signature_version=UNSIGNED))
    out = sts.assume_role_with_web_identity(
        RoleArn=cfg["role_arn"],
        RoleSessionName="even-studio-agent",
        WebIdentityToken=id_creds.token,
        DurationSeconds=cfg["duration"],
        Policy=json.dumps(session_policy(cfg["role_arn"], cfg["models"], cfg["region"]), separators=(",", ":")),
    )["Credentials"]
    return out


# ----------------------------------------------------------------------------- HTTP service
def _iso(ts) -> str:
    if hasattr(ts, "strftime"):
        return ts.strftime("%Y-%m-%dT%H:%M:%SZ")
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(float(ts)))


class Cache:
    def __init__(self, cfg, federate_fn, clock=time.time):
        self.cfg, self.fn, self.clock = cfg, federate_fn, clock
        self.lock = threading.Lock()
        self.value, self.expires = None, 0.0

    def get(self):
        with self.lock:
            if self.value is None or self.expires - self.clock() < REFRESH_MARGIN:
                c = self.fn(self.cfg)
                exp = c["Expiration"]
                self.expires = exp.timestamp() if hasattr(exp, "timestamp") else float(exp)
                self.value = {"Version": 1, "AccessKeyId": c["AccessKeyId"], "SecretAccessKey": c["SecretAccessKey"],
                              "SessionToken": c["SessionToken"], "Expiration": _iso(exp)}
            return dict(self.value)


class LimitedServer(ThreadingHTTPServer):
    """Thread per connection, but at most `max_connections` at once: a further connection is closed immediately."""
    daemon_threads = True

    def __init__(self, addr, handler, max_connections):
        super().__init__(addr, handler)
        self._slots = threading.BoundedSemaphore(max_connections)

    def process_request(self, request, client_address):
        if not self._slots.acquire(blocking=False):
            self.shutdown_request(request)
            return
        super().process_request(request, client_address)

    def process_request_thread(self, request, client_address):
        try:
            super().process_request_thread(request, client_address)
        finally:
            self._slots.release()


def make_handler(cfg: dict, cache: Cache):
    class Handler(BaseHTTPRequestHandler):
        server_version = "studio-broker"
        sys_version = ""
        timeout = cfg["read_timeout"]  # a connection that goes quiet is dropped

        def log_message(self, fmt, *args):  # ids only: caller address and outcome
            sys.stdout.write("%s %s\n" % (self.client_address[0], fmt % args))
            sys.stdout.flush()

        def _send(self, code, body=None):
            data = json.dumps(body).encode() if body is not None else b""
            self.send_response(code)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(data)))
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            self.wfile.write(data)

        def do_GET(self):
            try:
                src = ipaddress.ip_address(self.client_address[0])
            except ValueError:
                return self._send(403, {"error": "forbidden"})
            if not any(src in net for net in cfg["sources"]):
                return self._send(403, {"error": "forbidden"})
            supplied = self.headers.get("Authorization", "")
            expected = "Bearer " + cfg["token"]
            if not hmac.compare_digest(supplied.encode(), expected.encode()):
                return self._send(401, {"error": "unauthorized"})
            if self.path != "/creds":
                return self._send(404, {"error": "not found"})
            try:
                return self._send(200, cache.get())
            except Exception as exc:  # never include provider bodies
                sys.stdout.write("federation failed (%s)\n" % type(exc).__name__)
                sys.stdout.flush()
                return self._send(502, {"error": "federation failed"})

        do_POST = do_PUT = do_DELETE = do_PATCH = lambda self: self._send(405, {"error": "method not allowed"})

    return Handler


def serve(cfg: dict, federate_fn=federate, require_tailnet: bool = True) -> ThreadingHTTPServer:
    host = cfg["listen"][0]
    if require_tailnet and not is_tailnet(host):
        raise ConfigError(f"refusing to listen on {host}: not a tailnet address")
    return LimitedServer(cfg["listen"], make_handler(cfg, Cache(cfg, federate_fn)), cfg["max_connections"])


def main() -> int:
    try:
        cfg = load_config()
        srv = serve(cfg)
    except (ConfigError, ValueError) as exc:
        print("broker: %s" % exc, file=sys.stderr)
        return 2
    print("broker listening on %s:%d" % cfg["listen"], flush=True)
    srv.serve_forever()
    return 0


if __name__ == "__main__":
    sys.exit(main())
