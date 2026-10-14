# Architecture

Even Studio combines a Python agent with a CopilotKit runtime and a browser renderer. The `openGenerativeUI` runtime API and `generateSandboxedUi` tool connect them.

## Components

| Location                  | Responsibility                                            |
| ------------------------- | --------------------------------------------------------- |
| `apps/app/`               | Next.js frontend and `/api/copilotkit` runtime route      |
| `apps/agent/`             | FastAPI, LangGraph, Deep Agent, tools, prompt, and skills |
| `packages/design-system/` | Shared theme, SVG classes, and form styles                |

Node packages use pnpm/Turborepo. The Python agent uses uv.

## Request flow

```text
User prompt or chat starter suggestion
  → CopilotKit chat / agent run
  → Next.js /api/copilotkit
  → LangGraphHttpAgent → FastAPI agent
  → model + applicable tools and skills
  → text, native component, or generateSandboxedUi
  → CopilotKit activity stream → browser renderer
```

The agent uses `create_deep_agent`, CopilotKit middleware, a system-message ordering middleware, and `BoundedMemorySaver(max_threads=200)`. The checkpoint store is process memory, not durable shared storage. Restarting or scaling the agent can lose or split conversation state.

`src/model.py` builds Claude on AWS Bedrock (`ChatBedrockConverse`; sonnet for the agent, haiku as a second named model) as the primary and Vertex Gemini as a fallback used only when the primary call errors. Bedrock is reached through GCP federation (service-account key, ID token, STS `AssumeRoleWithWebIdentity`, auto-renewed) or the default AWS chain. The fallback wrapper drives the inner models through their private hooks so only one chat-model run is visible to LangGraph/AG-UI. When both fail, one error names both stages without secrets. No temperature/top_p/top_k is ever sent. There is no OpenAI, LangSmith or per-request key path.

`src/prompt.py` and the three agent skills guide response selection. Plain text is appropriate for direct answers. Native components handle supported structured tasks; custom UI serves useful diagrams, comparisons, calculators, and simulations. Planning is optional. See [Product and agent behavior](interactive-answers.md).

## Streaming custom UI

The runtime enables `openGenerativeUI`; its middleware translates `generateSandboxedUi` into `open-generative-ui` activity messages. The tool's ordered fields are:

1. `initialHeight`
2. `placeholderMessages`
3. `css`
4. `html`
5. `jsFunctions`
6. `jsExpressions`

The renderer holds the placeholder until CSS is complete, progressively updates a preview iframe, then initializes the final Websandbox iframe. Shared theme CSS and inlined d3/Chart.js are injected; the frame head is built by the host so the CSP meta is always first. JavaScript function/expression channels execute as classic scripts, so top-level await is invalid; asynchronous imports belong inside async functions.

The sandbox has no same-origin access to storage or host APIs. The host exposes only the validated `sendPrompt({ text })` callback through `Websandbox.connection.remote`, tagging each message `[widget-origin] `. Both frames carry the CSP `default-src 'none'; script-src 'unsafe-inline' 'unsafe-eval'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; connect-src 'none'; form-action 'none'; frame-src 'none'`. The host page has its own strict same-origin CSP (`src/lib/csp.ts`). Resize messages are checked and bounded before setting iframe height. Keep these boundaries intact when modifying the renderer.

A follow-up starts a new agent turn. Prior generated outputs serve as separate snapshots of that answer; their local controls can still change their own UI. There is no supported cross-call DOM patch API, and arbitrary iframe control state is not automatically synchronized to the agent. Follow-up buttons should include relevant selected values explicitly.

## Chat and evidence

The page shows CopilotChat; New chat starts a fresh thread. The agent has `plan_visualization` and six read-only governance tools (see "Studio zone" below); a renderer or native card never establishes a data connection.

## Telemetry

CopilotKit's telemetry clients are patched to no-ops (`patches/`), Segment is replaced by `stubs/segment-analytics-node`, and kill-switch env vars are set as defence in depth. Tests scan the build output and load the runtime with no kill-switch env, asserting zero non-localhost sockets.

## Key implementation files

- Agent: `apps/agent/main.py`, `src/model.py`, `src/prompt.py`, `skills/`.
- Runtime: `apps/app/src/app/api/copilotkit/route.ts`, `src/lib/copilotkit-runtime-options.ts`.
- Renderer: `apps/app/src/components/generative-ui/open-generative-ui/`.
- Host bridge: `apps/app/src/lib/sandbox/`.


## Studio zone (M0-S2)

- **Path.** The app serves under basePath `/studio`. even-elo's root app rewrites `/studio` and `/studio/:path*` to `${STUDIO_ORIGIN}/studio/...` only when `STUDIO_ORIGIN` is set; the doctors host stays 404 for `/studio`.
- **Browser to app.** `src/proxy.ts` (Next 16's renamed middleware, Node runtime) verifies the `epi_session` JWT (HS256, `JWT_SECRET`, `exp` required), refuses `kind=physician` and any `epi_physician_session` cookie, re-reads the role from the governance DB on every request over `GOV_RO_DATABASE_URL` (super_admin only; a pending `must_change_pin` is refused like the root middleware does), and checks Origin/Host (`governance.evenos.app`; localhost outside production) on every non-GET.
- **App to agent.** `/studio/api/copilotkit` calls `AGENT_URL` (ends in `/agent`) with `X-Studio-Service-Token` and a 45 s `X-Studio-Actor` JWT (aud `studio-agent`, random `jti`). Cookies are never forwarded; the proxy also strips every client `x-studio-*` and `authorization` header (CopilotKit forwards `x-*`), and passes the actor to the route in non-`x-` internal headers. The CopilotKit endpoint is `/api/copilotkit` (Next strips basePath).
- **Agent.** `apps/agent/src/studio_auth.py` is the first ASGI middleware: service token, actor JWT, jti replay (LRU plus `studio_nonce`), per-staff token bucket (`STUDIO_RATE_PER_MIN`). Threads are namespaced `<staff id>:<thread id>`. The staff id reaches tools only via the graph config.
- **Tools.** `studio_tools.py`: typed, parameterised, SELECT-only; one metadata-only `studio_audit` row per call; `STUDIO_LIVE_READS=0` serves synthetic fixtures without a redeploy. Results render through `SourceTable`, which refuses a payload without `source`.
- **State.** Checkpoints in Postgres (`STUDIO_DATABASE_URL`, langgraph-checkpoint-postgres); `migrations/0001_studio.sql` plus `apply_migration.py` (never run by CI). Without the URL the dev in-memory saver is used. Connections use `prepare_threshold=None` (no prepared statements). The read-only governance connection is non-autocommit with `read_only=True` (an autocommit connection would ignore it). Run the migration as a role that is NOT the app role: the owner can disable the append-only trigger (`apply_migration.py` refuses otherwise). Failed reads are audited too (`outcome=error`, 0 rows).
- **GOV_RO grants.** The role behind `GOV_RO_DATABASE_URL` gets SELECT on the six governance tables and, for the live role read, COLUMN grants only: `GRANT SELECT (id, status, is_super_admin) ON profiles_with_roles` and `GRANT SELECT (id, must_change_pin) ON profiles`. NEVER table-wide on either: `profiles_with_roles` is `SELECT p.*`, so a table-wide grant on the view exposes `password_hash` and `email` just like one on `profiles`. The statement takes `must_change_pin` from `profiles` because the view is frozen at even-elo migration 015 and lacks it (as even-elo's login route does). `tests/test_studio_live_staff_sql.py` runs it as a role with exactly these grants against the real even-elo migrations and asserts `password_hash` is refused on both the table and the view (and that a table-wide view grant would leak it); `tests/test_lc1_live_probe.py` checks the same on the live role.
- **Where GOV_RO_DATABASE_URL lives.** It is required on the even-studio Vercel project (the app's live role read) AND on the Asus agent (the read tools). It is never set on even-elo. Create the role with `ops/neon/run-roles.sh` (owner URL from a 0600 file, `--dry-run` to preview): role `studio_gov_ro`, NOINHERIT, no superuser/createdb/createrole/replication/bypassrls, CONNECTION LIMIT 5, `default_transaction_read_only=on`, `statement_timeout=15s`, `idle_in_transaction_session_timeout=30s`, and exactly the grants above. `tests/test_studio_roles.py` applies it to a scratch Postgres and runs the live probe as that role; run the probe once against Neon after the real run.
- **Retention.** Checkpoints keep full chat and tool rows: archive threads (`studio_threads.archived`), never delete from the app; ops decides cold storage. Prune `studio_nonce` rows older than a day.
- **TODO (ops, step 8).** The studio project's own URL trusts `X-Forwarded-Host` only because the Origin check and the host-scoped SameSite=Lax cookie back it up. Enable Vercel Deployment Protection or an origin-only ingress for the studio project. `STUDIO_ORIGIN` is baked into the routes manifest at build time, so changing it needs a redeploy.
- **Tests.** `cd apps/agent && uv run --python 3.12 --with pgserver python -m pytest` also runs the 11 real-Postgres tests (plain `pytest` skips them). The built-app test (`studio-basepath-integration.test.ts`) needs `pnpm --filter @repo/app build` first; unbuilt it skips locally and FAILS when CI is set.
