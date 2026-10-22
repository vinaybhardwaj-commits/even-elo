"use client";

import { useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
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
  const toggleRef = useRef<HTMLButtonElement>(null);
  const close = () => {
    setChoice(false);
    toggleRef.current?.focus();
  };
  // Below 1100 px the open panel overlays the page, header toggle included: Escape and the panel's own close button
  // close it (a click aimed at the covered toggle would land on the chat, e.g. a message's copy button).
  useEffect(() => {
    if (!panelOpen || wide) return;
    const onKey = (e: KeyboardEvent) => {
      // Not when something else already handled it (a menu or dialog inside the chat closing itself) or when the
      // key ends an IME composition in the chat input.
      if (e.key === "Escape" && !e.defaultPrevented && !e.isComposing) {
        setChoice(false);
        toggleRef.current?.focus();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [panelOpen, wide]);
  return (
    <div className="studio-frame">
      <a className="chat-skip" href="#screen-main">
        Skip to content
      </a>
      <StudioNav />
      <main id="screen-main" className="scr-main">
        <header className="scr-head">
          <h1>{title}</h1>
          <button ref={toggleRef} type="button" className="scr-ask-toggle" aria-expanded={panelOpen} aria-controls="screen-ask" onClick={() => setChoice(!panelOpen)}>
            {panelOpen ? "Hide assistant" : "Ask the assistant"}
          </button>
        </header>
        {children}
      </main>
      <aside id="screen-ask" className="scr-panel" data-open={panelOpen} aria-label="Assistant">
        {panelOpen && (
          <>
            <div className="scr-panel-head">
              <button type="button" className="scr-ask-toggle scr-panel-close" onClick={close}>
                Close assistant
              </button>
            </div>
            <AskPanel screenTitle={title} />
          </>
        )}
      </aside>
    </div>
  );
}
