import { describe, expect, it, vi } from "vitest";
import { HTTP_TOOL_CLIENT_PARAMS, HTTP_TOOL_DESCRIPTIONS, callHttpTool } from "../client";
import { HTTP_TOOL_NAMES } from "@/lib/screens/tool-schema";

const okFetch = (body: unknown, status = 200) => vi.fn(async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch;

describe("callHttpTool", () => {
  it("posts to the same-origin screen route with cookies and no redirects", async () => {
    const f = okFetch({ ok: true });
    await callHttpTool("eiris_incidents", { view: "summary" }, f);
    const [url, init] = (f as unknown as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/studio/api/screen/eiris_incidents");
    expect(init.method).toBe("POST");
    expect(init.credentials).toBe("same-origin");
    expect(init.redirect).toBe("error");
    expect(JSON.parse(String(init.body))).toEqual({ view: "summary" });
  });

  it("drops include_text whatever the model sends", async () => {
    const f = okFetch({ ok: true });
    await callHttpTool("eiris_incident_detail", { incident_id: "EHRC-INC-2026-1", include_text: true }, f);
    const [, init] = (f as unknown as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(String(init.body))).toEqual({ incident_id: "EHRC-INC-2026-1" });
  });

  it("hands the role-gate refusal to the model as a fixed code", async () => {
    const out = await callHttpTool("opd_signals", {}, okFetch({ ok: false, error: "forbidden" }, 403));
    expect(JSON.parse(out)).toEqual({ ok: false, error: "forbidden" });
  });

  it("returns fixed codes when the network or the body fails", async () => {
    const down = vi.fn(async () => {
      throw new Error("secret host");
    }) as unknown as typeof fetch;
    expect(JSON.parse(await callHttpTool("opd_signals", {}, down))).toEqual({ ok: false, error: "unreachable" });
    const html = vi.fn(async () => new Response("<html>", { status: 502 })) as unknown as typeof fetch;
    expect(JSON.parse(await callHttpTool("opd_signals", {}, html))).toEqual({ ok: false, error: "bad_payload" });
  });

  it("describes and types every HTTP tool, none offering include_text", () => {
    for (const name of HTTP_TOOL_NAMES) {
      expect(HTTP_TOOL_DESCRIPTIONS[name].length).toBeGreaterThan(20);
      expect(Object.keys(HTTP_TOOL_CLIENT_PARAMS[name].shape)).not.toContain("include_text");
    }
  });
});
