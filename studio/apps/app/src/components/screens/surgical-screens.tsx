"use client";

import { useMemo, useState, type ReactNode } from "react";
import { useSurgicalTool } from "@/lib/surgical/use-surgical-tool";
import type { SurgicalReadParams, SurgicalWriteName, SurgicalWriteParams } from "@/lib/surgical/schema";
import { BASE_PATH, DataTable, StatTile, ToolSection } from "./parts";
import { ScreenFrame } from "./screen-frame";
import { ConfirmCard, SurgicalSubnav, useSurgicalContext } from "./surgical-parts";

type Row = Record<string, string | number | boolean | null>;
const cell = (v: unknown) => (v === null || v === undefined ? "–" : String(v));
const nullable = (s: string) => (s.trim() === "" ? null : s.trim());
const numOrNull = (s: string) => (s.trim() === "" || !Number.isFinite(Number(s)) ? null : Number(s));

/** One pending write: which action, its typed params, and the summary the card shows. */
type Pending<A extends SurgicalWriteName = SurgicalWriteName> = { action: A; params: SurgicalWriteParams<A>; summary: Array<[string, ReactNode]> };

function Pend({ pending, onClose, onDone }: { pending: Pending | null; onClose: () => void; onDone: () => void }) {
  return pending ? <ConfirmCard action={pending.action} params={pending.params} summary={pending.summary} onClose={onClose} onDone={onDone} /> : null;
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label>
      {label}
      {children}
    </label>
  );
}

// ---- Overview ---------------------------------------------------------------------------------------

export function SurgicalOverviewScreen() {
  const counts = useSurgicalTool("surgical_overview", {});
  const boardParams = useMemo<SurgicalReadParams<"surgical_leaderboard">>(() => ({ status: "active", limit: 100 }), []);
  const board = useSurgicalTool("surgical_leaderboard", boardParams);
  const [pending, setPending] = useState<Pending | null>(null);
  useSurgicalContext("surgical_overview", {}, {}, [
    { tool: "surgical_overview", params: {}, state: counts },
    { tool: "surgical_leaderboard", params: boardParams, state: board },
  ]);
  return (
    <ScreenFrame title="Surgical governance">
      <SurgicalSubnav current="/surgical" />
      <ToolSection title="At a glance" state={counts} retry={counts.retry}>
        {(data) => (
          <div className="scr-tiles">
            {data.rows.map((r) => (
              <StatTile key={String(r.metric)} label={String(r.metric).replace(/_/g, " ")} value={r.value as number | string | null} data={data} />
            ))}
          </div>
        )}
      </ToolSection>
      <ToolSection title="Leaderboard" note="Latest score snapshot per active visiting consultant" state={board} retry={board.retry}>
        {(data) => (
          <DataTable
            data={data}
            columns={["full_name", "specialty", "composite", "caseload", "outcomes", "adherence", "tier", "low_confidence", "cases_in_window", "computed"]}
            rowHref={(row) => (row.vc_id ? `/surgical/vcs/${String(row.vc_id)}` : null)}
            empty="No score snapshots yet."
          />
        )}
      </ToolSection>
      <section className="scr-card" aria-label="Recompute">
        <header className="scr-card-head">
          <h2>Recompute</h2>
          <p>Recalculates every active VC score from the current data.</p>
        </header>
        <button type="button" onClick={() => setPending({ action: "recompute_all", params: {}, summary: [["Scope", "every active VC"]] })}>
          Review recompute
        </button>
      </section>
      <Pend pending={pending} onClose={() => setPending(null)} onDone={() => { setPending(null); counts.retry(); board.retry(); }} />
    </ScreenFrame>
  );
}

// ---- Visiting consultants ---------------------------------------------------------------------------

export function SurgicalVcsScreen() {
  const [all, setAll] = useState(false);
  const params = useMemo<SurgicalReadParams<"surgical_vcs">>(() => ({ status: all ? "all" : "active", limit: 500 }), [all]);
  const vcs = useSurgicalTool("surgical_vcs", params);
  const [pending, setPending] = useState<Pending | null>(null);
  const [form, setForm] = useState({ vc_id: "", full_name: "", specialty: "", registration_no: "", notes: "", status: "active" as "active" | "suspended" | "terminated" });
  const set = (k: keyof typeof form) => (e: { target: { value: string } }) => setForm((f) => ({ ...f, [k]: e.target.value }));
  useSurgicalContext("surgical_vcs", {}, { include_inactive: all }, [{ tool: "surgical_vcs", params, state: vcs }]);

  const review = (e: { preventDefault: () => void }) => {
    e.preventDefault();
    const base = { full_name: form.full_name.trim(), specialty: form.specialty.trim(), registration_no: nullable(form.registration_no), notes: nullable(form.notes) };
    if (!base.full_name || !base.specialty) return;
    const summary: Array<[string, ReactNode]> = [["Name", base.full_name], ["Specialty", base.specialty], ["Registration", base.registration_no], ["Notes", base.notes]];
    setPending(
      form.vc_id
        ? { action: "vc_update", params: { vc_id: form.vc_id, ...base, status: form.status }, summary: [["VC", form.vc_id], ...summary, ["Status", form.status]] }
        : { action: "vc_create", params: base, summary },
    );
  };
  return (
    <ScreenFrame title="Visiting consultants">
      <SurgicalSubnav current="/surgical/vcs" />
      <label className="scr-muted">
        <input type="checkbox" checked={all} onChange={(e) => setAll(e.target.checked)} /> Include suspended and terminated
      </label>
      <ToolSection title="Roster" state={vcs} retry={vcs.retry}>
        {(data) => (
          <DataTable
            data={data}
            columns={["full_name", "specialty", "registration_no", "status", "updated"]}
            rowHref={(row) => (row.vc_id ? `/surgical/vcs/${String(row.vc_id)}` : null)}
            renderCell={{
              full_name: (v, row) => (row.vc_id ? <a href={`${BASE_PATH}/surgical/vcs/${String(row.vc_id)}`}>{cell(v)}</a> : cell(v)),
            }}
            empty="No visiting consultants."
          />
        )}
      </ToolSection>
      <form className="scr-filters scr-form" onSubmit={review} aria-label="Add or edit a visiting consultant">
        <Field label="VC id (blank to add)">
          <input value={form.vc_id} onChange={set("vc_id")} maxLength={36} />
        </Field>
        <Field label="Name">
          <input value={form.full_name} onChange={set("full_name")} maxLength={120} required />
        </Field>
        <Field label="Specialty">
          <input value={form.specialty} onChange={set("specialty")} maxLength={80} required />
        </Field>
        <Field label="Registration">
          <input value={form.registration_no} onChange={set("registration_no")} maxLength={60} />
        </Field>
        <Field label="Notes">
          <input value={form.notes} onChange={set("notes")} maxLength={500} />
        </Field>
        <Field label="Status (edit only)">
          <select value={form.status} onChange={set("status")}>
            <option value="active">Active</option>
            <option value="suspended">Suspended</option>
            <option value="terminated">Terminated</option>
          </select>
        </Field>
        <button type="submit">Review change</button>
      </form>
      <Pend pending={pending} onClose={() => setPending(null)} onDone={() => { setPending(null); vcs.retry(); }} />
    </ScreenFrame>
  );
}

const SECTIONS = ["summary", "components", "snapshots", "cases", "activity"] as const;

export function SurgicalVcScreen({ id }: { id: string }) {
  const [section, setSection] = useState<(typeof SECTIONS)[number]>("summary");
  const params = useMemo<SurgicalReadParams<"surgical_vc_detail">>(() => ({ vc_id: id, section, limit: 100 }), [id, section]);
  const detail = useSurgicalTool("surgical_vc_detail", params);
  useSurgicalContext("surgical_vc", { vc_id: id }, { section }, [{ tool: "surgical_vc_detail", params, state: detail }]);
  return (
    <ScreenFrame title="Visiting consultant">
      <SurgicalSubnav current="/surgical/vcs" />
      <div className="scr-pager" role="tablist" aria-label="Sections">
        {SECTIONS.map((s) => (
          <button key={s} type="button" role="tab" aria-selected={s === section} onClick={() => setSection(s)}>
            {s}
          </button>
        ))}
      </div>
      <ToolSection title={section} state={detail} retry={detail.retry}>
        {(data) => <DataTable data={data} columns={data.columns.filter((c) => c !== "case_id")} empty="Nothing recorded." />}
      </ToolSection>
    </ScreenFrame>
  );
}

// ---- Cases ------------------------------------------------------------------------------------------

export function SurgicalCasesScreen() {
  const [vc, setVc] = useState("");
  const [applied, setApplied] = useState("");
  const [allStatus, setAllStatus] = useState(false);
  const params = useMemo<SurgicalReadParams<"surgical_cases">>(() => ({ ...(applied ? { vc_id: applied } : {}), status: allStatus ? "all" : "completed", limit: 200 }), [applied, allStatus]);
  const cases = useSurgicalTool("surgical_cases", /^[0-9a-f-]{36}$/i.test(applied) || applied === "" ? params : null);
  const [pending, setPending] = useState<Pending | null>(null);
  useSurgicalContext("surgical_cases", applied ? { vc_id: applied } : {}, { include_non_completed: allStatus }, [{ tool: "surgical_cases", params, state: cases }]);
  return (
    <ScreenFrame title="Surgical cases">
      <SurgicalSubnav current="/surgical/cases" />
      <form className="scr-filters scr-form" onSubmit={(e) => { e.preventDefault(); setApplied(vc.trim()); }}>
        <Field label="VC id">
          <input value={vc} onChange={(e) => setVc(e.target.value)} maxLength={36} />
        </Field>
        <label className="scr-muted">
          <input type="checkbox" checked={allStatus} onChange={(e) => setAllStatus(e.target.checked)} /> Include voided and cancelled
        </label>
        <button type="submit">Apply</button>
      </form>
      <ToolSection title="Cases" note="Patient identity is not shown; cases are identified by case reference." state={cases} retry={cases.retry}>
        {(data) => (
          <DataTable
            data={data}
            columns={["case_ref", "surgery_date", "surgeon", "specialty", "procedure", "status", "los_days", "case_id"]}
            labels={{ case_id: "action" }}
            renderCell={{
              case_id: (v, row) =>
                row.status === "completed" && typeof v === "string" ? (
                  <button type="button" onClick={() => setPending({ action: "case_void", params: { case_id: v }, summary: [["Case", cell(row.case_ref)], ["Surgeon", cell(row.surgeon)], ["Date", cell(row.surgery_date)]] })}>
                    Void
                  </button>
                ) : (
                  "–"
                ),
            }}
            empty="No cases match."
          />
        )}
      </ToolSection>
      <Pend pending={pending} onClose={() => setPending(null)} onDone={() => { setPending(null); cases.retry(); }} />
    </ScreenFrame>
  );
}

// ---- Streams ----------------------------------------------------------------------------------------

export function SurgicalStreamsScreen() {
  const streams = useSurgicalTool("surgical_streams", {});
  const [pending, setPending] = useState<Pending | null>(null);
  const [edit, setEdit] = useState<Row | null>(null);
  const [f, setF] = useState({ floor: "", target: "", active: true, recompute: false });
  useSurgicalContext("surgical_streams", {}, {}, [{ tool: "surgical_streams", params: {}, state: streams }]);
  const open = (row: Row) => {
    setEdit(row);
    setF({ floor: row.floor_value === null ? "" : String(row.floor_value), target: row.target_value === null ? "" : String(row.target_value), active: row.active === true, recompute: false });
  };
  return (
    <ScreenFrame title="Stream catalogue">
      <SurgicalSubnav current="/surgical/streams" />
      <ToolSection title="Streams" note="Floor and target map each stream onto 0–100." state={streams} retry={streams.retry}>
        {(data) => (
          <DataTable
            data={data}
            columns={["label", "component", "team_owner", "data_type", "default_rule", "direction", "floor_value", "target_value", "active", "stream_id"]}
            labels={{ stream_id: "action" }}
            renderCell={{ stream_id: (_v, row) => <button type="button" onClick={() => open(row)}>Edit</button> }}
          />
        )}
      </ToolSection>
      {edit && (
        <form
          className="scr-filters scr-form"
          aria-label={`Edit ${cell(edit.label)}`}
          onSubmit={(e) => {
            e.preventDefault();
            setPending({
              action: "stream_update",
              params: { stream_id: String(edit.stream_id), floor_value: numOrNull(f.floor), target_value: numOrNull(f.target), active: f.active, recompute_all: f.recompute },
              summary: [["Stream", cell(edit.label)], ["Floor", cell(numOrNull(f.floor))], ["Target", cell(numOrNull(f.target))], ["Active", String(f.active)], ["Recompute all VCs after", String(f.recompute)]],
            });
          }}
        >
          <Field label="Floor">
            <input value={f.floor} onChange={(e) => setF({ ...f, floor: e.target.value })} inputMode="decimal" />
          </Field>
          <Field label="Target">
            <input value={f.target} onChange={(e) => setF({ ...f, target: e.target.value })} inputMode="decimal" />
          </Field>
          <label className="scr-muted">
            <input type="checkbox" checked={f.active} onChange={(e) => setF({ ...f, active: e.target.checked })} /> Active
          </label>
          <label className="scr-muted">
            <input type="checkbox" checked={f.recompute} onChange={(e) => setF({ ...f, recompute: e.target.checked })} /> Recompute all VCs
          </label>
          <button type="submit">Review change</button>
          <button type="button" onClick={() => setEdit(null)}>Close</button>
        </form>
      )}
      <Pend pending={pending} onClose={() => setPending(null)} onDone={() => { setPending(null); setEdit(null); streams.retry(); }} />
    </ScreenFrame>
  );
}

// ---- Weights ----------------------------------------------------------------------------------------

export function SurgicalWeightsScreen() {
  const params = useMemo<SurgicalReadParams<"surgical_weights">>(() => ({ limit: 50 }), []);
  const weights = useSurgicalTool("surgical_weights", params);
  const [pending, setPending] = useState<Pending | null>(null);
  const [w, setW] = useState({ c: "", o: "", a: "", why: "" });
  useSurgicalContext("surgical_weights", {}, {}, [{ tool: "surgical_weights", params, state: weights }]);
  const c = Number(w.c), o = Number(w.o), a = Number(w.a);
  const valid = [c, o, a].every((n) => Number.isInteger(n) && n >= 0 && n <= 100) && c + o + a === 100 && w.c !== "" && w.o !== "" && w.a !== "";
  return (
    <ScreenFrame title="Weight versions">
      <SurgicalSubnav current="/surgical/weights" />
      <ToolSection title="History" state={weights} retry={weights.retry}>
        {(data) => <DataTable data={data} columns={data.columns.filter((x) => x !== "version_id")} empty="No weight versions." />}
      </ToolSection>
      <form
        className="scr-filters scr-form"
        aria-label="New weight version"
        onSubmit={(e) => {
          e.preventDefault();
          if (!valid) return;
          setPending({ action: "weights_apply", params: { caseload_pct: c, outcomes_pct: o, adherence_pct: a, rationale: nullable(w.why) }, summary: [["Caseload %", c], ["Outcomes %", o], ["Adherence %", a], ["Rationale", nullable(w.why)], ["Effect", "recomputes every active VC"]] });
        }}
      >
        <Field label="Caseload %"><input value={w.c} onChange={(e) => setW({ ...w, c: e.target.value })} inputMode="numeric" /></Field>
        <Field label="Outcomes %"><input value={w.o} onChange={(e) => setW({ ...w, o: e.target.value })} inputMode="numeric" /></Field>
        <Field label="Adherence %"><input value={w.a} onChange={(e) => setW({ ...w, a: e.target.value })} inputMode="numeric" /></Field>
        <Field label="Rationale"><input value={w.why} onChange={(e) => setW({ ...w, why: e.target.value })} maxLength={500} /></Field>
        <button type="submit" disabled={!valid}>Review change</button>
        {!valid && (w.c || w.o || w.a) && <span className="scr-muted">Three whole numbers that sum to 100.</span>}
      </form>
      <Pend pending={pending} onClose={() => setPending(null)} onDone={() => { setPending(null); weights.retry(); }} />
    </ScreenFrame>
  );
}

// ---- Positions --------------------------------------------------------------------------------------

export function SurgicalPositionsScreen() {
  const positions = useSurgicalTool("surgical_positions", {});
  const [pending, setPending] = useState<Pending | null>(null);
  const [edit, setEdit] = useState<{ name: string; description: string } | null>(null);
  useSurgicalContext("surgical_positions", {}, {}, [{ tool: "surgical_positions", params: {}, state: positions }]);
  return (
    <ScreenFrame title="Positions">
      <SurgicalSubnav current="/surgical/positions" />
      <ToolSection title="Positions" state={positions} retry={positions.retry}>
        {(data) => (
          <DataTable
            data={data}
            columns={["position_name", "team", "description", "active", "edit"]}
            renderCell={{ edit: (_v, row) => <button type="button" onClick={() => setEdit({ name: String(row.position_name), description: row.description === null ? "" : String(row.description) })}>Edit</button> }}
          />
        )}
      </ToolSection>
      {edit && (
        <form
          className="scr-filters scr-form"
          aria-label={`Edit ${edit.name}`}
          onSubmit={(e) => {
            e.preventDefault();
            setPending({ action: "position_update", params: { position_name: edit.name, description: nullable(edit.description) }, summary: [["Position", edit.name], ["Description", nullable(edit.description)]] });
          }}
        >
          <Field label="Description"><input value={edit.description} onChange={(e) => setEdit({ ...edit, description: e.target.value })} maxLength={500} /></Field>
          <button type="submit">Review change</button>
          <button type="button" onClick={() => setEdit(null)}>Close</button>
        </form>
      )}
      <Pend pending={pending} onClose={() => setPending(null)} onDone={() => { setPending(null); setEdit(null); positions.retry(); }} />
    </ScreenFrame>
  );
}

// ---- Audit log --------------------------------------------------------------------------------------

const PAGE = 100;
const TOKEN = /^[A-Za-z0-9_.:-]{1,60}$/;

export function SurgicalAuditScreen() {
  const [draft, setDraft] = useState({ action: "", entity: "", actor: "" });
  const [applied, setApplied] = useState(draft);
  const [offset, setOffset] = useState(0);
  const params = useMemo<SurgicalReadParams<"surgical_audit_log">>(
    () => ({
      limit: PAGE,
      offset,
      ...(TOKEN.test(applied.action) ? { action: applied.action } : {}),
      ...(TOKEN.test(applied.entity) ? { entity_type: applied.entity } : {}),
      ...(applied.actor.trim() ? { actor: applied.actor.trim().slice(0, 60) } : {}),
    }),
    [applied, offset],
  );
  const log = useSurgicalTool("surgical_audit_log", params);
  useSurgicalContext("surgical_audit", {}, { action: applied.action, entity_type: applied.entity, actor: applied.actor, offset }, [{ tool: "surgical_audit_log", params, state: log }]);
  return (
    <ScreenFrame title="even-elo audit log">
      <SurgicalSubnav current="/surgical/audit" />
      <form className="scr-filters scr-form" onSubmit={(e) => { e.preventDefault(); setApplied(draft); setOffset(0); }}>
        <Field label="Action"><input value={draft.action} onChange={(e) => setDraft({ ...draft, action: e.target.value })} maxLength={60} /></Field>
        <Field label="Entity type"><input value={draft.entity} onChange={(e) => setDraft({ ...draft, entity: e.target.value })} maxLength={60} /></Field>
        <Field label="Actor"><input value={draft.actor} onChange={(e) => setDraft({ ...draft, actor: e.target.value })} maxLength={60} /></Field>
        <button type="submit">Apply</button>
      </form>
      <ToolSection title="Entries" note="Who, what and when. Before and after content stays in even-elo." state={log} retry={log.retry}>
        {(data) => (
          <>
            <DataTable data={data} empty="No entries match." />
            <nav className="scr-pager" aria-label="Audit pages">
              <button type="button" disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - PAGE))}>Previous</button>
              <button type="button" disabled={data.row_count < PAGE} onClick={() => setOffset(offset + PAGE)}>Next</button>
            </nav>
          </>
        )}
      </ToolSection>
    </ScreenFrame>
  );
}
