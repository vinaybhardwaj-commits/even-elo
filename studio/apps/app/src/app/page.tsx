"use client";

import { useEffect, useRef, useState } from "react";
import { useChatSession } from "@/components/chat/chat-session";
import { ReaderScrollView } from "@/components/chat/reader-scroll-view";
import { AnswerMarkdown } from "@/components/chat/answer-markdown";
import {
  CopilotChat,
  useAgent,
  useCopilotKit,
} from "@copilotkit/react-core/v2";
import { useGenerativeUIExamples } from "@/hooks";
import { StudioNav } from "@/components/screens/studio-nav";
import { useRunError } from "@/lib/use-run-error";

export default function HomePage() {
  useGenerativeUIExamples();
  const { agent } = useAgent();
  const { newChat } = useChatSession();
  const { copilotkit } = useCopilotKit();
  const { error, setError, onError, clear, beginRetry } = useRunError(agent);
  const [retrying, setRetrying] = useState(false);
  const retryingRef = useRef(false);
  const chatRoot = useRef<HTMLDivElement>(null);
  const latestQuestion = agent.messages.filter((message) => message.role === "user").at(-1)?.id;

  // Move only when a question is submitted. Streamed text and growing visuals
  // must never take scroll ownership from the reader.
  useEffect(() => {
    if (!latestQuestion || !chatRoot.current) return;
    const root = chatRoot.current;
    const revealQuestion = () => {
      const question = Array.from(root.querySelectorAll<HTMLElement>('[data-testid="copilot-user-message"]'))
        .find((element) => element.dataset.messageId === latestQuestion);
      if (!question) return false;
      question.scrollIntoView?.({ block: "start", behavior: "instant" });
      return true;
    };
    if (revealQuestion()) return;
    const observer = new MutationObserver(() => {
      if (revealQuestion()) observer.disconnect();
    });
    observer.observe(root, { childList: true, subtree: true });
    return () => observer.disconnect();
  }, [latestQuestion]);

  const retry = async () => {
    if (retryingRef.current || agent.isRunning) return;
    if (!beginRetry()) return;
    retryingRef.current = true;
    setRetrying(true);
    clear();
    try {
      await copilotkit.runAgent({ agent });
    } catch {
      setError(
        "The agent is unavailable. Check the agent service configuration, then retry.",
      );
    } finally {
      retryingRef.current = false;
      setRetrying(false);
    }
  };

  return (
    <div className="studio-frame">
    <StudioNav />
    <div className="chat-app">
      <a className="chat-skip" href="#main-content">
        Skip to chat
      </a>
      <header className="chat-header">
        <span className="chat-name">Even Studio</span>
        <nav aria-label="Main navigation">
          <button type="button" onClick={newChat} disabled={agent.isRunning || retrying}>
            New chat
          </button>
        </nav>
      </header>
      <main id="main-content" className="chat-main">
        {error && (
          <div className="chat-error" role="alert">
            <p>{error}</p>
            <button
              type="button"
              onClick={retry}
              disabled={retrying || agent.isRunning}
            >
              Retry answer
            </button>
          </div>
        )}
        <div className="chat-content" ref={chatRoot}>
          <CopilotChat
            autoScroll={false}
            scrollView={ReaderScrollView}
            messageView={{ assistantMessage: { markdownRenderer: AnswerMarkdown } }}
            onError={onError}
            labels={{
              welcomeMessageText: "What would you like to explore?",
              chatInputPlaceholder: "Ask anything…",
              chatDisclaimerText:
                "AI can make mistakes. Check important details.",
            }}
          />
        </div>
      </main>
    </div>
    </div>
  );
}
