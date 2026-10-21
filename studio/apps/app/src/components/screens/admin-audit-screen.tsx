"use client";

import { useMemo, useState } from "react";
import type { AdminParams } from "@/lib/screens/admin-schema";
import { useAdmin } from "@/lib/screens/use-admin";
import { DataTable, ToolSection } from "./parts";
import { AdminSubnav, asScreenState } from "./admin-parts";
import { ScreenFrame } from "./screen-frame";
import { useScreenContext } from "./screen-context";

// Audit log: the read part of even-elo /api/audit (the `audit_log` table). Before/after JSON is not loaded.
// This is the app's change log, not the Studio's own studio_audit read log.
const PAGE = 100;
type Filters = { action: string; entity_type: string; actor: string };
const EMPTY: Filters = { action: "", entity_type: "", actor: "" };

export function toParams(f: Filters, offset: number): AdminParams<"audit"> {
  const p: AdminParams<"audit"> = { limit: PAGE, offset };
  if (f.action.trim()) p.action = f.action.trim();
  if (f.entity_type.trim()) p.entity_type = f.entity_type.trim();
  if (f.actor.trim()) p.actor = f.actor.trim();
  return p;
}

export function AdminAuditScreen() {
  const [draft, setDraft] = useState<Filters>(EMPTY);
  const [applied, setApplied] = useState<Filters>(EMPTY);
  const [offset, setOffset] = useState(0);
  const params = useMemo(() => toParams(applied, offset), [applied, offset]);
  const list = useAdmin("audit", params);

  useScreenContext("admin-audit", {}, { table: "audit log", ...params }, [{ tool: "admin_audit", params, state: asScreenState(list) }]);

  const set = (k: keyof Filters) => (e: { target: { value: string } }) => setDraft((d) => ({ ...d, [k]: e.target.value }));
  return (
    <ScreenFrame title="Audit log">
      <AdminSubnav current="/admin/audit" />
      <p className="scr-muted">Changes recorded by the governance app, newest first. Before and after values are on the old page only.</p>
      <form
        className="scr-filters scr-form"
        aria-label="Audit filters"
        onSubmit={(e) => {
          e.preventDefault();
          setApplied(draft);
          setOffset(0);
        }}
      >
        <label>
          Action
          <input value={draft.action} onChange={set("action")} maxLength={60} />
        </label>
        <label>
          Entity type
          <input value={draft.entity_type} onChange={set("entity_type")} maxLength={60} />
        </label>
        <label>
          Actor position
          <input value={draft.actor} onChange={set("actor")} maxLength={60} />
        </label>
        <button type="submit">Apply</button>
        <button
          type="button"
          onClick={() => {
            setDraft(EMPTY);
            setApplied(EMPTY);
            setOffset(0);
          }}
        >
          Clear
        </button>
      </form>
      <ToolSection title="Entries" state={asScreenState(list)} retry={list.retry}>
        {(data) => (
          <>
            <DataTable data={data} columns={["at", "actor_position", "action", "entity_type", "entity_id"]} labels={{ at: "when", actor_position: "actor" }} empty="No entries match." />
            <nav className="scr-pager" aria-label="Audit pages">
              <span className="scr-muted">
                Showing {data.row_count === 0 ? 0 : offset + 1}–{offset + data.row_count}
              </span>
              <button type="button" disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - PAGE))}>
                Previous
              </button>
              <button type="button" disabled={data.row_count < PAGE} onClick={() => setOffset(offset + PAGE)}>
                Next
              </button>
            </nav>
          </>
        )}
      </ToolSection>
    </ScreenFrame>
  );
}
