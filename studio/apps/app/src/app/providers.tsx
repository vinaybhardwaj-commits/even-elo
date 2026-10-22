"use client";

import { Suspense } from "react";
import { CopilotKit } from "@copilotkit/react-core";
import { CopilotChatConfigurationProvider } from "@copilotkit/react-core/v2";
import { OPEN_GEN_UI_DESIGN_SKILL } from "@repo/design-system";
import { OPEN_GEN_UI_ACTIVITY_RENDERER } from "@/components/generative-ui/open-generative-ui";
import { SANDBOX_FUNCTIONS } from "@/lib/sandbox/sandbox-functions";
import { OpenGenUIPromptBridge } from "@/lib/sandbox/prompt-bridge";
import { tableCatalog } from "@/components/generative-ui/table-catalog";
import { ChatSessionProvider, useChatSession } from "@/components/chat/chat-session";
import { AccessProvider } from "@/lib/zone/access-context";
import { ThemeProvider } from "@/hooks/use-theme";
import { installCopilotFetchGuard } from "@/lib/copilot-fetch-guard";

// Before any CopilotKit effect runs: caps runtime POSTs (no connect for unrun threads, bounded re-issues, backoff).
installCopilotFetchGuard();

const a2ui = { catalog: tableCatalog };

const renderActivityMessages = [OPEN_GEN_UI_ACTIVITY_RENDERER];
const openGenerativeUI = {
  sandboxFunctions: [...SANDBOX_FUNCTIONS],
  designSkill: OPEN_GEN_UI_DESIGN_SKILL,
};

export function Providers({ children, role }: { children: React.ReactNode; role?: string }) {
  const inner = (
    <ThemeProvider>
      <ChatSessionProvider>
        <ChatProviders>{children}</ChatProviders>
      </ChatSessionProvider>
    </ThemeProvider>
  );
  return role === undefined ? inner : <AccessProvider role={role}>{inner}</AccessProvider>;
}

function ChatProviders({ children }: { children: React.ReactNode }) {
  const { session } = useChatSession();
  return (
    <CopilotKit
      key={session}
      runtimeUrl="/studio/api/copilotkit"
      showDevConsole={false}
      enableInspector={false}
      renderActivityMessages={renderActivityMessages}
      openGenerativeUI={openGenerativeUI}
      a2ui={a2ui}
    >
      {/* Hydration that suspends below here (a slow client chunk) must not retry the provider: each uncommitted
          render of CopilotKitProvider builds a new core in a fresh ref, and each core fetches runtime info. Live
          overview showed ~140 info calls in one burst this way. With this boundary the provider commits once. */}
      <Suspense fallback={null}>
        <CopilotChatConfigurationProvider>
          <OpenGenUIPromptBridge />
          {children}
        </CopilotChatConfigurationProvider>
      </Suspense>
    </CopilotKit>
  );
}
