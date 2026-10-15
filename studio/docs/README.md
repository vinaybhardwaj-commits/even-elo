# Even Studio documentation

A hardened private fork (see the root README "Fork notice") of CopilotKit's OpenIntelligentUI: answers you can interact with, for Even Healthcare governance work.

Local prerequisites: Node.js 22+, pnpm 9, Python 3.12 with uv, and the environment variables in `.env.example` (Bedrock model ids and GCP federation inputs, plus `TYPESAFE_API_KEY` for Jev routing).

| Guide | Description |
| --- | --- |
| [Product and agent behavior](interactive-answers.md) | Response selection, evidence, and follow-ups |
| [Visualization routing](visualization-routing.md) | Jev, A2UI tables, charts, diagrams |
| [Architecture](architecture.md) | Agent, runtime, models, streaming renderer, sandbox, CSP |
| [Generative UI](generative-ui.md) | Native components and the sandboxed streaming rail |

Upstream tutorial guides (agent state, tools, human-in-the-loop, bring-to-your-app, deployment, MCP) were removed from this fork because they described removed demo features, OpenAI/BYOK configuration and the upstream hosted deployment. Deployment and authentication arrive in M0-S2.
