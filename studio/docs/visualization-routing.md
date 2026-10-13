# Visualization routing

Jev (`jev-latest`) makes one typed presentation decision for each new user message through [TypeSafe's System One API](https://docs.typesafe.ai/introduction/quickstart). It receives up to four recent user/assistant text messages, capped at 6,000 characters each. It does not receive API keys, system instructions, raw tool outputs, or generated tool code. Sending these turns to Jev is an approved egress (zero data retention); revisit for PHI scope in M0-S2.

| Selected visualization | Renderer |
| --- | --- |
| Text | Normal chat answer |
| Table | A2UI Table catalog |
| Bar, line, scatter, distribution, part-to-whole chart | Open Generative UI |
| Flowchart, static or interactive diagram | Open Generative UI |
| Calculator | Open Generative UI |

The renderer is derived from Jev's validated choice, preventing contradictory renderer/type pairs. The selection is stored with the user message ID in thread state and reused during tool continuations. A new user message is classified again with conversation context. Middleware filters rendering tools after CopilotKit injects them; unrelated data/state tools remain available. The answer model receives the selected visualization type plus the relevant rendering contract.

The A2UI catalog supplies a semantic HTML table with column headers, a caption, keyboard-focusable horizontal scrolling, and a required provenance label. It accepts at most 12 columns and 200 rows and rejects mismatched row widths. React renders values as text. Charts and diagrams continue to use the existing isolated sandbox.

Set `TYPESAFE_API_KEY` (env only; there is no per-request key) and optionally `JEV_MODEL=jev-latest` on the agent server. Provider secrets never belong in browser variables. Jev authentication failures, invalid choices, and timeouts fail the turn with a retryable error; there is no silent fallback claiming that Jev made a decision. Successful health checks confirm the server is running, not provider access.

Routing is a model judgment, not a guarantee of the objectively best visualization. Missing source data still requires clarification or explicit illustrative assumptions. Live provider checks and browser checks complement the deterministic routing, error-path, continuation, and A2UI rendering tests.
