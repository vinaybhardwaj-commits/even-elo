"use client";

import { useCallback, useEffect, useState } from "react";
import { RmoInboxPayload, type RmoInboxParams, type RmoOp } from "./rmo-schema";
import type { ScreenToolState } from "./use-screen-tool";

export const RMO_API = "/studio/api/rmo";

export type RmoInboxState = { status: "loading" } | { status: "ok"; data: RmoInboxPayload } | { status: "error"; code: string };

const errCode = (body: unknown) => (body && typeof body === "object" && "error" in body && typeof body.error === "string" ? body.error : "tool_failed");

/** Loads the RMO inbox through /studio/api/rmo/inbox. `params` is compared by value. */
export function useRmoInbox(params: RmoInboxParams): RmoInboxState & { retry: () => void } {
  const key = JSON.stringify(params);
  const [attempt, setAttempt] = useState(0);
  const id = `${key}|${attempt}`;
  const [settled, setSettled] = useState<{ id: string; result: RmoInboxState } | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    const done = (result: RmoInboxState) => {
      if (!controller.signal.aborted) setSettled({ id, result });
    };
    (async () => {
      try {
        const res = await fetch(`${RMO_API}/inbox`, { method: "POST", headers: { "Content-Type": "application/json" }, body: key, signal: controller.signal, cache: "no-store" });
        const body: unknown = await res.json().catch(() => null);
        if (!res.ok) return done({ status: "error", code: errCode(body) });
        const parsed = RmoInboxPayload.safeParse(body);
        done(parsed.success ? { status: "ok", data: parsed.data } : { status: "error", code: "bad_payload" });
      } catch {
        done({ status: "error", code: "agent_unreachable" });
      }
    })();
    return () => controller.abort();
  }, [key, id]);

  const state: RmoInboxState = settled && settled.id === id ? settled.result : { status: "loading" };
  const retry = useCallback(() => setAttempt((n) => n + 1), []);
  return { ...state, retry };
}

/** One confirmed write. Resolves to an error code, or null on success. */
export async function postRmoWrite(op: Exclude<RmoOp, "inbox">, body: Record<string, string>): Promise<string | null> {
  try {
    const res = await fetch(`${RMO_API}/${op}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), cache: "no-store" });
    if (res.ok) return null;
    return errCode(await res.json().catch(() => null));
  } catch {
    return "upstream_unreachable";
  }
}

/** The single items table as the generic screen state the shared context hook takes. */
export const asScreenState = (s: RmoInboxState): ScreenToolState => (s.status === "ok" ? { status: "ok", data: s.data.items } : s.status === "error" ? s : { status: "loading" });
