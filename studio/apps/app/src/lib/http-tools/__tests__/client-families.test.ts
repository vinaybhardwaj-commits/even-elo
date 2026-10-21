import { describe, expect, it, vi } from "vitest";
import { FAMILY_CHAT_TOOLS, ONBOARDING_ROUTE, SURGICAL_ROUTE, callFamilyTool } from "../client-families";

const okFetch = () => vi.fn(async () => new Response(JSON.stringify({ ok: true }), { status: 200 })) as unknown as typeof fetch;

describe("family chat tools", () => {
  it("registers every surgical and onboarding read, and no write", () => {
    const names = FAMILY_CHAT_TOOLS.map((t) => t.name);
    expect(names.filter((n) => n.startsWith("surgical_"))).toHaveLength(9);
    expect(names.filter((n) => n.startsWith("onboarding_"))).toHaveLength(5);
    expect(names.join()).not.toMatch(/write|create|update|void|recompute|decision|observation_add/);
    for (const t of FAMILY_CHAT_TOOLS) expect(t.description.length).toBeGreaterThan(20);
  });

  it("posts each family to its own same-origin route", async () => {
    const f = okFetch();
    const surgical = FAMILY_CHAT_TOOLS.find((t) => t.name === "surgical_overview")!;
    const onboarding = FAMILY_CHAT_TOOLS.find((t) => t.name === "onboarding_hospitals")!;
    await callFamilyTool(surgical, {}, f);
    await callFamilyTool(onboarding, {}, f);
    const urls = (f as unknown as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0]);
    expect(urls).toEqual([`${SURGICAL_ROUTE}/surgical_overview`, `${ONBOARDING_ROUTE}/onboarding_hospitals`]);
  });
});
