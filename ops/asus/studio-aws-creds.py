#!/usr/bin/env python3
"""AWS credential_process helper for the Studio agent (installed as /usr/local/bin/studio-aws-creds).

botocore runs this (see /etc/studio-agent/aws-config) whenever it needs credentials. It asks the t4 credential broker over
the tailnet for short-lived credentials that can only invoke the two pinned Bedrock models, and prints them in the
credential_process JSON format. The broker URL and bearer token come from the agent's environment. The system proxy settings
are ignored on purpose: the broker is reached directly (nft allows exactly that address and port for the agent uid).
Nothing secret is written to stderr.
"""
import json
import os
import sys
import urllib.request

REQUIRED = ("Version", "AccessKeyId", "SecretAccessKey", "SessionToken", "Expiration")


def main() -> int:
    url, token = os.environ.get("STUDIO_BROKER_URL", ""), os.environ.get("STUDIO_BROKER_TOKEN", "")
    if not url or not token:
        print("studio-aws-creds: STUDIO_BROKER_URL / STUDIO_BROKER_TOKEN not set", file=sys.stderr)
        return 1
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    req = urllib.request.Request(url, headers={"Authorization": "Bearer " + token})
    try:
        with opener.open(req, timeout=10) as resp:
            body = json.loads(resp.read())
    except Exception as exc:  # no response bodies, no URLs with credentials
        print("studio-aws-creds: broker request failed (%s)" % type(exc).__name__, file=sys.stderr)
        return 1
    if not isinstance(body, dict) or any(k not in body for k in REQUIRED):
        print("studio-aws-creds: broker answer is not a credential_process document", file=sys.stderr)
        return 1
    print(json.dumps({k: body[k] for k in REQUIRED}))
    return 0


if __name__ == "__main__":
    sys.exit(main())
