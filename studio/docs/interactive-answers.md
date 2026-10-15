# Product and agent behavior

**Even Studio: answers you can interact with.** The experience helps people understand something, compare options, or make a useful tool for the moment.

## Choosing the response

| User task                                    | Useful response                                               |
| -------------------------------------------- | ------------------------------------------------------------- |
| A quick fact, writing, code, or conversation | Direct text                                                   |
| A basic table or exact-value comparison      | A2UI Table selected by Jev                                     |
| Understand a mechanism or relationship       | Diagram or interactive explainer                              |
| Compare options                              | Table, criteria, and tradeoffs; adjustable weights if helpful |
| Make a tool                                  | Functional inputs, computation, outputs, and reset            |

Jev selects the presentation for each turn: A2UI for basic tables, Open Generative UI for charts, diagrams and calculators, or text. See [Visualization routing](visualization-routing.md). The agent can combine text and multiple distinct sections. It does not need to announce a plan or narrate a completed UI back to the user. `plan_visualization` remains available for work where an explicit plan helps. A successful “UI generated” result is not a reason to rebuild the same answer.

## Chat and generated answers

The interface is a chat. Users type any request. Each submission starts agent generation, subject to the configured provider and available tools. The header provides New chat.

Generated UI must have functional controls, readable labels, keyboard access, responsive layout, reduced-motion support, and clear loading/error states. Numeric tools must reject blank, non-finite, out-of-range, and zero-divisor inputs; show units and assumptions; and avoid NaN, Infinity, and misleading stale outputs.

## Provenance

Distinguish user-provided values, retrieved evidence, calculated results, and illustrative assumptions. Label sample values inside the UI where users see them. No data tool is connected yet, so the agent must ask for inputs or explain the limitation. It must not invent current data, sources, authentication, saved records, or external actions.

## Follow-up snapshots

Treat each generated answer as its own conversation artifact. A follow-up is a new turn and can produce a new snapshot; it does not silently rewrite earlier outputs through an assumed patch API. “Snapshot” describes the generated answer, not frozen controls: users can still interact with a rendered tool locally.

The sandbox's control state is not automatically agent memory. A deliberate “Ask about this scenario” action should include validated current selections in `Websandbox.connection.remote.sendPrompt({ text })`. Ordinary filters and sliders run locally. Never auto-send messages on load, timers, or input changes. Use clear action labels and error feedback.

## Technical contract and scope

The ordered streaming contract and sandbox rules are documented in [Architecture](architecture.md). The model factory uses LangChain Bedrock and Vertex clients and does not change pinned models.
