// Role x screen matrix, browser side: nav links and registered chat tools (cosmetic; the server is the gate).
import { render, cleanup, screen } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const captured = vi.hoisted(() => ({ frontend: [] as string[], render: [] as string[] }));
vi.mock("@copilotkit/react-core/v2", () => ({
  useComponent: () => {},
  useFrontendTool: (c: { name: string }) => void captured.frontend.push(c.name),
  useHumanInTheLoop: () => {},
  useRenderTool: (c: { name: string }) => void captured.render.push(c.name),
  useDefaultRenderTool: () => {},
}));
vi.mock("@/hooks/use-theme", () => ({ useTheme: () => ({ theme: "light", setTheme: vi.fn() }) }));
vi.mock("next/navigation", () => ({ usePathname: () => "/overview" }));
vi.mock("next/link", () => ({ default: ({ href, children }: { href: string; children: React.ReactNode }) => <a href={href}>{children}</a> }));

import { useGenerativeUIExamples } from "../use-generative-ui-examples";
import { StudioNav } from "@/components/screens/studio-nav";
import { AccessProvider } from "@/lib/zone/access-context";

const ROLES = {
  super_admin: "staff,super_admin",
  sgc_member: "staff,sgc_member",
  site_medical_head: "staff,site_medical_head",
  hr: "staff,hr",
  plain_staff: "staff",
};
const ALL_LABELS = ["Overview", "Physicians", "Audit findings", "Document audits", "CDMSS", "RMO inbox", "e-IRIS incidents", "Patient feedback", "Surgical", "Onboarding", "Admin", "Chat"];
const HIDDEN: Record<keyof typeof ROLES, string[]> = {
  super_admin: [],
  sgc_member: ["Surgical", "Admin"],
  site_medical_head: ["e-IRIS incidents", "Surgical", "Admin"],
  hr: ["Audit findings", "CDMSS", "e-IRIS incidents", "Surgical", "Admin"],
  plain_staff: ["Audit findings", "CDMSS", "e-IRIS incidents", "Surgical", "Admin"],
};

function Probe() {
  useGenerativeUIExamples();
  return null;
}

beforeEach(() => {
  captured.frontend.length = 0;
  captured.render.length = 0;
});
afterEach(cleanup);

describe("nav shows only the allowed screens", () => {
  for (const [persona, role] of Object.entries(ROLES) as Array<[keyof typeof ROLES, string]>) {
    it(persona, () => {
      render(
        <AccessProvider role={role}>
          <StudioNav />
        </AccessProvider>,
      );
      const shown = screen.getAllByRole("link").map((a) => a.textContent);
      expect(shown).toEqual(ALL_LABELS.filter((l) => !HIDDEN[persona].includes(l)));
    });
  }
  it("an empty role (header missing) shows only Chat", () => {
    render(
      <AccessProvider role="">
        <StudioNav />
      </AccessProvider>,
    );
    expect(screen.getAllByRole("link").map((a) => a.textContent)).toEqual(["Chat"]);
  });
});

describe("chat registers only the allowed tools", () => {
  const GATED: Record<string, string[]> = {
    eiris_incidents: ["super_admin", "sgc_member"],
    audit_findings: ["super_admin", "sgc_member", "site_medical_head"],
    surgical_vcs: ["super_admin"],
    onboarding_pipeline: ["super_admin", "sgc_member", "site_medical_head", "hr", "plain_staff"],
  };
  for (const [persona, role] of Object.entries(ROLES)) {
    it(persona, () => {
      render(
        <AccessProvider role={role}>
          <Probe />
        </AccessProvider>,
      );
      for (const [tool, who] of Object.entries(GATED)) {
        expect(captured.frontend.includes(tool), `${persona} ${tool}`).toBe(who.includes(persona));
      }
      expect(captured.render).toContain("overview_counts");
    });
  }
});
