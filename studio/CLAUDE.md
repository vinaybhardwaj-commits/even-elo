# Even Studio (hardened private fork of CopilotKit OpenIntelligentUI)

This repository builds a general assistant experience around **answers you can interact with**: understand a topic, compare options, or make a useful tool. The agent currently has one tool (`plan_visualization`); governance tools arrive in M1.

## Boundaries and source of truth

- Frontend: `apps/app/`, Next.js and CopilotKit v2.
- Agent: `apps/agent/main.py`, `src/prompt.py`, `src/model.py`, and `skills/`.
- Custom UI: `apps/app/src/components/generative-ui/open-generative-ui/`.
- Validated host callbacks: `apps/app/src/lib/sandbox/`.
- Shared styling: `packages/design-system/`.

Use the product name in visible copy. Preserve repository URLs, package names, `openGenerativeUI`, `generateSandboxedUi`, activity/event names, and deployment service names unless a task explicitly migrates them.

## Agent behavior

Choose text for direct answers, native components when their schemas fit, and custom UI when a diagram or interaction helps. There is no mandatory acknowledgement/plan/build/narrate sequence. Distinct sections may use multiple tools; do not repeat a successful build merely because it returned "UI generated".

Label sample assumptions and distinguish user inputs, retrieved evidence, and calculated values. There is no data connection yet and no built-in live weather or business-data source. Never imply a generated form authenticates or persists data.

Generated controls must work, validate numerical edge cases, support keyboard access and narrow screens, and expose useful errors. Use the user's selected values when sending a deliberate follow-up. Each follow-up is a new turn/output; do not assume a cross-call patch API or persist iframe state through rerenders.

## Streaming contract

Emit `initialHeight`, `placeholderMessages`, `css`, `html`, `jsFunctions`, `jsExpressions` in that order. Styles belong in `css`; functions and invocations use their separate channels. Those JavaScript channels run as classic scripts, so dynamic imports with await belong inside async functions, never at top level.

Use the existing validated `Websandbox.connection.remote.sendPrompt({ text })` bridge (the host tags it `[widget-origin]`; `openLink` was removed). Do not replace it with unrestricted parent messages. The sandbox has no same-origin storage or fetch access. Preserve preview isolation, final sandbox initialization, and incremental streaming behavior.

## Configuration and checks

Models are Bedrock (primary: `BEDROCK_MODEL_SONNET` / `BEDROCK_MODEL_HAIKU`, region `BEDROCK_REGION`) with Vertex Gemini as fallback only (`VERTEX_MODEL`). Bedrock credentials come from GCP federation (default) or the AWS env chain; see `.env.example`. Jev routing requires `TYPESAFE_API_KEY`. No OpenAI, LangSmith, telemetry, or per-request keys. Do not invent native model APIs or silently change pinned model IDs.

```bash
pnpm install --frozen-lockfile
pnpm test
uv run --directory apps/agent pytest
pnpm lint
pnpm build
```

Use focused tests while developing, then relevant workspace checks. Browser and live-provider validation is separate from the build. A rendered chat shell does not prove AI generation works. Keep secrets out of source, generated UI, logs, and screenshots. Do not describe a local build as a deployed release.

See [Architecture](docs/architecture.md) and [Product and agent behavior](docs/interactive-answers.md).
