"use client";

import { useCallback, useEffect, useState } from "react";
import { AdminPayload, type AdminParams } from "./admin-schema";

export const ADMIN_API = "/studio/api/admin";

export type AdminState = { status: "loading" } | { status: "ok"; data: AdminPayload } | { status: "error"; code: string };
type ReadOp = "users" | "roles" | "resignations" | "audit";

const errCode = (body: unknown) => (body && typeof body === "object" && "error" in body && typeof body.error === "string" ? body.error : "tool_failed");

/** Loads one admin read through /studio/api/admin/<op>. `params` is compared by value; null = do not load. */
export function useAdmin<O extends ReadOp>(op: O, params: AdminParams<O> | null): AdminState & { retry: () => void } {
  const key = params === null ? null : JSON.stringify(params);
  const [attempt, setAttempt] = useState(0);
  const id = `${op}|${key}|${attempt}`;
  const [settled, setSettled] = useState<{ id: string; result: AdminState } | null>(null);

  useEffect(() => {
    if (key === null) return;
    const controller = new AbortController();
    const done = (result: AdminState) => {
      if (!controller.signal.aborted) setSettled({ id, result });
    };
    (async () => {
      try {
        const res = await fetch(`${ADMIN_API}/${op}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: key, signal: controller.signal, cache: "no-store" });
        const body: unknown = await res.json().catch(() => null);
        if (!res.ok) return done({ status: "error", code: errCode(body) });
        const parsed = AdminPayload.safeParse(body);
        done(parsed.success ? { status: "ok", data: parsed.data } : { status: "error", code: "bad_payload" });
      } catch {
        done({ status: "error", code: "agent_unreachable" });
      }
    })();
    return () => controller.abort();
  }, [op, key, id]);

  const state: AdminState = key === null ? { status: "loading" } : settled && settled.id === id ? settled.result : { status: "loading" };
  const retry = useCallback(() => setAttempt((n) => n + 1), []);
  return { ...state, retry };
}

/** One confirmed write. Resolves to an error code, or null on success. */
export async function postAdminWrite(op: "set_status" | "grant_role" | "process_resignation", body: Record<string, string>): Promise<string | null> {
  try {
    const res = await fetch(`${ADMIN_API}/${op}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), cache: "no-store" });
    if (res.ok) return null;
    return errCode(await res.json().catch(() => null));
  } catch {
    return "upstream_unreachable";
  }
}
