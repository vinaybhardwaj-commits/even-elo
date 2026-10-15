# Even Studio

Interactive answers for Even Healthcare governance work: a chat interface whose
replies can include tables, charts, and small working tools rendered in a
network-off sandbox.

## Fork notice

This is a hardened private fork for Even Healthcare of
[CopilotKit/OpenIntelligentUI](https://github.com/CopilotKit/OpenIntelligentUI),
taken at upstream commit `9c982df1` (12 Oct 2026). Upstream is licensed under the
MIT License (see [LICENSE](LICENSE)); MIT permits private modification and use, and
the copyright and permission notice are retained. Changes in this fork (milestone M0-S1):

- no third-party telemetry, analytics, or Google Fonts requests;
- no OpenAI, LangSmith, or bring-your-own-key paths;
- models: AWS Bedrock (Claude Sonnet, Haiku) primary, Vertex Gemini fallback only;
- generated widgets run under a CSP with `connect-src 'none'`, with d3 and Chart.js inlined;
- demo content removed; the agent ships with no domain tools yet (M1).

## Layout

- `apps/app` - Next.js 16 / React 19 frontend (CopilotKit v2).
- `apps/agent` - Python 3.12 FastAPI + LangGraph agent (`uv`).
- `packages/design-system` - shared widget CSS and the vendored chart libraries
  (`pnpm --filter @repo/design-system vendor` regenerates them).

## Configure

Copy `.env.example` values into `apps/agent/.env` (agent) and `apps/app/.env.local`
(frontend). Bedrock credentials come from GCP federation (or the AWS chain);
nothing is read from the browser. Never commit a populated `.env`.

## Develop and check

```bash
pnpm install --frozen-lockfile
pnpm -r test && pnpm -r typecheck
pnpm --filter @repo/app build
uv sync --directory apps/agent && uv run --directory apps/agent pytest
```

The rate limiter in `apps/app/src/app/api/copilotkit/route.ts` is in-process and
off by default; it is replaced in M0-S2.
