"use client";

import { useState, useSyncExternalStore, type ReactNode } from "react";
import { CopilotChat, useAgent } from "@copilotkit/react-core/v2";
import { AnswerMarkdown } from "@/components/chat/answer-markdown";
import { useGenerativeUIExamples } from "@/hooks";
import { useRunError } from "@/lib/use-run-error";
import { StudioNav } from "./studio-nav";

function AskPanel({ screenTitle }: { screenTitle: string }) {
  // Same typed renderers as the chat page: governance tool results render as SourceTable with a source line.
  useGenerativeUIExamples();
  const { agent } = useAgent();
  const { error, onError } = useRunError(agent);
  return (
    <div className="scr-panel-body">
      {error && (
        <p className="scr-error" role="alert">
          {error}
        </p>
      )}
      <CopilotChat
        messageView={{ assistantMessage: { markdownRenderer: AnswerMarkdown } }}
        onError={onError}
        labels={{
          welcomeMessageText: `Ask about ${screenTitle.toLowerCase()}`,
          chatInputPlaceholder: "Ask about anything on this screen…",
          chatDisclaimerText: "AI can make mistakes. Check important details.",
        }}
      />
    </div>
  );
}

const WIDE = "(min-width: 1100px)";
function subscribeWide(cb: () => void) {
  const mq = window.matchMedia(WIDE);
  mq.addEventListener("change", cb);
  return () => mq.removeEventListener("change", cb);
}
const isWide = () => window.matchMedia(WIDE).matches;

/** Left nav + fixed screen layout + the CopilotKit chat as a side panel that knows the screen. */
export function ScreenFrame({ title, children }: { title: string; children: ReactNode }) {
  // Open by default on wide screens, closed on narrow ones; the user's choice wins once made.
  const wide = useSyncExternalStore(subscribeWide, isWide, () => true);
  const [choice, setChoice] = useState<boolean | null>(null);
  const panelOpen = choice ?? wide;
  return (
    <div className="studio-frame">
      <a className="chat-skip" href="#screen-main">
        Skip to content
      </a>
      <StudioNav />
      <main id="screen-main" className="scr-main">
        <header className="scr-head">
          <h1>{title}</h1>
          <button type="button" className="scr-ask-toggle" aria-expanded={panelOpen} aria-controls="screen-ask" onClick={() => setChoice(!panelOpen)}>
            {panelOpen ? "Hide assistant" : "Ask the assistant"}
          </button>
        </header>
        {children}
      </main>
      <aside id="screen-ask" className="scr-panel" data-open={panelOpen} aria-label="Assistant">
        {panelOpen && <AskPanel screenTitle={title} />}
      </aside>
    </div>
  );
}
