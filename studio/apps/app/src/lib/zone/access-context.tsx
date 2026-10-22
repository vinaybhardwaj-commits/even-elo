"use client";

import { createContext, useContext, useMemo, type ReactNode } from "react";
import { ROLE_FLAGS, canAccessScreen, canUseTool, encodeRoles, type ScreenId } from "./access";

// Cosmetic only: hides nav links and chat tools the role cannot use. The server decides (proxy.ts, the routes, the
// agent); this never grants anything. Without a provider (unit tests of single components) everything shows.
const ALL = encodeRoles(Object.fromEntries(ROLE_FLAGS.map((f) => [f, true])));
const AccessContext = createContext<string>(ALL);

export function AccessProvider({ role, children }: { role: string; children: ReactNode }) {
  return <AccessContext.Provider value={role}>{children}</AccessContext.Provider>;
}

export function useAccess() {
  const role = useContext(AccessContext);
  return useMemo(
    () => ({ role, canScreen: (s: ScreenId) => canAccessScreen(role, s), canTool: (t: string) => canUseTool(role, t) }),
    [role],
  );
}
