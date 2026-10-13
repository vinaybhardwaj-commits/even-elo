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

The page shows CopilotChat; New chat starts a fresh thread. The agent currently has one tool, `plan_visualization`; no data connection exists, and neither a renderer nor a native card establishes one. Governance tools arrive in M1.

## Telemetry

CopilotKit's telemetry clients are patched to no-ops (`patches/`), Segment is replaced by `stubs/segment-analytics-node`, and kill-switch env vars are set as defence in depth. Tests scan the build output and load the runtime with no kill-switch env, asserting zero non-localhost sockets.

## Key implementation files

- Agent: `apps/agent/main.py`, `src/model.py`, `src/prompt.py`, `skills/`.
- Runtime: `apps/app/src/app/api/copilotkit/route.ts`, `src/lib/copilotkit-runtime-options.ts`.
- Renderer: `apps/app/src/components/generative-ui/open-generative-ui/`.
- Host bridge: `apps/app/src/lib/sandbox/`.

