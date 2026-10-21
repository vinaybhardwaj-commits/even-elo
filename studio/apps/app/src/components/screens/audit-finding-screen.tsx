"use client";

import Link from "next/link";
import { useMemo } from "react";
import { AUDIT_REF_RE } from "@/lib/screens/tool-schema";
import { useScreenTool } from "@/lib/screens/use-screen-tool";
import { SourceLine, ToolSection } from "./parts";
import { RulingCard } from "./ruling-card";
import { ScreenFrame } from "./screen-frame";
import { useScreenContext } from "./screen-context";

type DetailRow = { section: string; field: string; value: string | number | boolean | null };

/** Group the section/field/value rows by section, keeping order. */
export function groupSections(rows: Array<Record<string, string | number | boolean | null>>): Array<[string, DetailRow[]]> {
  const out = new Map<string, DetailRow[]>();
  for (const r of rows) {
    const section = String(r.section ?? "");
    const list = out.get(section) ?? [];
    list.push({ section, field: String(r.field ?? ""), value: r.value ?? null });
    out.set(section, list);
  }
  return [...out.entries()];
}

const SECTION_TITLE = (s: string) => (s === "thread" ? "Thread" : s === "response" ? "Doctor response" : s === "ruling" ? "Ruling" : s === "evidence" ? "Evidence" : s.replace(/_/g, " "));

export function AuditFindingScreen({ reference }: { reference: string }) {
  const valid = AUDIT_REF_RE.test(reference);
  // Doctor comment, ruling note and finding rationale are shown on this screen only (super_admin; the chat never gets them).
  const params = useMemo(() => (valid ? { reference } : null), [valid, reference]);
  const detail = useScreenTool("audit_finding_detail", params);

  useScreenContext("audit_finding", { reference: valid ? reference : "(invalid reference)" }, {}, [{ tool: "audit_finding_detail", params, state: detail }]);

  const status = detail.status === "ok" ? String(detail.data.rows.find((r) => r.section === "thread" && r.field === "status")?.value ?? "") : "";

  return (
    <ScreenFrame title={valid ? reference : "Audit finding"}>
      <p>
        <Link href="/audit-findings">← All findings</Link>
      </p>
      {!valid && (
        <p className="scr-error" role="alert">
          This is not a valid thread reference.
        </p>
      )}
      {valid && (
        <>
          <ToolSection title="Finding" note="Read from CDMSS, with doctor comments, ruling notes and rationale as on the audit page." state={detail} retry={detail.retry}>
            {(data) => {
              const sections = groupSections(data.rows);
              const events = sections.filter(([s]) => s.startsWith("event_"));
              const evidence = sections.filter(([s]) => s === "evidence" || s.startsWith("evidence_"));
              const rest = sections.filter(([s]) => !s.startsWith("event_") && s !== "evidence" && !s.startsWith("evidence_"));
              return (
                <>
                  {rest.map(([s, rows]) => (
                    <div key={s}>
                      <h3 className="scr-sub">{SECTION_TITLE(s)}</h3>
                      <Dl rows={rows} />
                    </div>
                  ))}
                  <h3 className="scr-sub">Evidence</h3>
                  {evidence.length === 0 ? <p className="scr-muted">No evidence instances.</p> : evidence.map(([s, rows]) => <Dl key={s} rows={rows} />)}
                  <h3 className="scr-sub">Timeline</h3>
                  {events.length === 0 ? <p className="scr-muted">No events recorded.</p> : (
                    <ol className="scr-list">
                      {events.map(([s, rows]) => {
                        const f = (k: string) => rows.find((r) => r.field === k)?.value;
                        return (
                          <li key={s}>
                            {String(f("at") ?? "–")} · {String(f("event") ?? "event")} · {String(f("actor") ?? "system")}
                            {f("note") ? ` · ${String(f("note"))}` : ""}
                          </li>
                        );
                      })}
                    </ol>
                  )}
                  <SourceLine data={data} />
                </>
              );
            }}
          </ToolSection>
          <RulingCard reference={reference} status={status} />
        </>
      )}
    </ScreenFrame>
  );
}

function Dl({ rows }: { rows: DetailRow[] }) {
  return (
    <dl className="scr-dl">
      {rows.map((r) => (
        <div key={r.field}>
          <dt>{r.field.replace(/_/g, " ")}</dt>
          <dd>{r.value === null ? "–" : String(r.value)}</dd>
        </div>
      ))}
    </dl>
  );
}
