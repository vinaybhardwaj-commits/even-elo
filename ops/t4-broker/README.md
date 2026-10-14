# ops/t4-broker: credential broker (runs on t4, tailnet only)

The Asus agent no longer holds a GCP key or does the GCP -> AWS federation. This broker does it on t4 and hands the agent
**short-lived AWS credentials that can only invoke the two pinned Bedrock models**. Because the Asus no longer talks to Google at all,
no `*.googleapis.com` name is on its allowlist (Google front ends route on the HTTP Host header, so an SNI allowlist cannot contain them).

```
Asus agent (botocore) --credential_process--> /usr/local/bin/studio-aws-creds --tailnet HTTP, bearer token--> broker (t4)
broker: GCP SA key -> impersonate SA -> ID token -> STS AssumeRoleWithWebIdentity(GCPBedrockRole, session policy, 900-3600 s)
```

- **Session policy** (`broker.session_policy`): `Allow bedrock:InvokeModel` and `bedrock:InvokeModelWithResponseStream` on the inference-profile
  ARN(s) for the pinned model ids in `ap-south-1` and the matching foundation-model ARN(s) (a `global.*` profile routes, so the model ARN has any region).
  Condition `aws:RequestedRegion = ap-south-1`: that key is the region of the API endpoint that receives the call (not where a cross-region inference profile routes the
  model), so the `global.*` profile keeps working while stolen credentials cannot call `bedrock-runtime` in any other region. The foundation-model ARN keeps region `*` because
  AWS, not the caller, picks the profile's destination regions. If AWS ever evaluates a destination region as the requested region, widen the condition to the regions the
  profile routes to (verify on the live account). Nothing else; a session policy can only narrow the role. `test_broker.py` evaluates the policy offline: pinned models allowed, every other action,
  model, account or region denied. *Verify once on the live account that Bedrock accepts these ARN forms (ask the refuter to test it).*
- **Client auth**: the caller's source address must be one of `BROKER_ALLOWED_SOURCES` (**single IPs only**: bare, or /32 or /128; a range is refused by both the installer and the broker; 403 otherwise) and it must send
  `Authorization: Bearer <BROKER_TOKEN>` (401 otherwise). The broker **refuses to start** on a non-tailnet listen address (100.64.0.0/10, fd7a:115c:a1e0::/48).
- **Hardening**: own uid `studio-broker`, systemd sandboxing like the agent (`systemd-analyze security` is checked in the container test). The one deliberate
  difference: `AF_UNIX` is allowed (DNS may go through resolved/nscd on t4) and there is no `IPAddressDeny` (Google and STS cannot be an IP allowlist).
- **Availability**: at most `BROKER_MAX_CONNECTIONS` (32) connections at a time (the next is closed at once) and a silent connection is dropped after `BROKER_READ_TIMEOUT` (10 s).
- The generated `BROKER_TOKEN` is written by python straight into the env file: it is never on a command line.
- Credentials are cached in memory and re-issued when less than 10 minutes remain. Logs carry the caller address and outcome only.

## Install (on t4)
```
sudo ./install-studio-broker.sh --listen <t4 tailnet IP>:8765 --allowed-source <Asus tailnet IP> --gcp-key-file <existing SA key on t4>
sudoedit /etc/studio-broker/env      # BROKER_ROLE_ARN=arn:aws:iam::<acct>:role/GCPBedrockRole, BROKER_GCP_AUDIENCE=<audience>
sudo ./install-studio-broker.sh ... # rerun: starts the service when the env is complete
```
`BROKER_TOKEN` is generated on first install. Copy it to the Asus **by stdin, file-to-file** (never through chat, never in argv):
`ssh t4 'sudo sed -n s/^BROKER_TOKEN=//p /etc/studio-broker/env' | ssh asus 'sudo ./install-studio-agent.sh --receive-broker-token'`.
The Asus installer's `--broker <t4 tailnet IP>:8765` writes `STUDIO_BROKER_URL` and opens the agent uid to exactly that address and port.

`--stop` disables the broker (credentials already issued live out their TTL, at most one hour); `--purge` also shreds its key copy and env.
Tests: `python3 -m unittest test_broker` (stdlib only, offline).
