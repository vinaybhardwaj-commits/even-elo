"use client";

import { createContext, useContext, useState, type ReactNode } from "react";

type ChatSessionValue = { session: number; newChat: () => void };
const ChatSessionContext = createContext<ChatSessionValue | null>(null);

/** Bumping `session` remounts the CopilotKit tree, starting a fresh thread. */
export function ChatSessionProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState(0);
  return (
    <ChatSessionContext.Provider
      value={{ session, newChat: () => setSession((value) => value + 1) }}
    >
      {children}
    </ChatSessionContext.Provider>
  );
}

export function useChatSession() {
  const value = useContext(ChatSessionContext);
  if (!value) throw new Error("ChatSessionProvider is required");
  return value;
}
