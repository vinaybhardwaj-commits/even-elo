"use client";

import { useMemo, useState, type ReactNode } from "react";
import { useOnboardingTool } from "@/lib/onboarding/use-onboarding-tool";
import {
  COMMITMENT_KEYS,
  SCORE_DIMENSIONS,
  STAGES,
  type OnboardingReadParams,
  type OnboardingWriteName,
  type OnboardingWriteParams,
} from "@/lib/onboarding/schema";
import { BASE_PATH, DataTable, StatTile, ToolSection } from "./parts";
import { ScreenFrame } from "./screen-frame";
import { ConfirmCard, OnboardingSubnav, useOnboardingContext } from "./onboarding-parts";

const cell = (v: unknown) => (v === null || v === undefined ? "–" : String(v));
const nullable = (s: string) => (s.trim() === "" ? null : s.trim());

type Pending<A extends OnboardingWriteName = OnboardingWriteName> = { action: A; params: OnboardingWriteParams<A>; summary: Array<[string, ReactNode]> };

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

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// ---- Pipeline (the /onboarding list) ----------------------------------------------------------------

export function OnboardingPipelineScreen() {
  const [stage, setStage] = useState<"" | (typeof STAGES)[number]>("");
  const counts = useOnboardingTool("onboarding_overview", {});
  const params = useMemo<OnboardingReadParams<"onboarding_pipeline">>(() => ({ ...(stage ? { stage } : {}), limit: 500 }), [stage]);
  const pipeline = useOnboardingTool("onboarding_pipeline", params);
  useOnboardingContext("onboarding_pipeline", {}, { stage: stage || null }, [
    { tool: "onboarding_overview", params: {}, state: counts },
    { tool: "onboarding_pipeline", params, state: pipeline },
  ]);
  return (
    <ScreenFrame title="VC onboarding">
      <OnboardingSubnav current="/onboarding" />
      <ToolSection title="At a glance" state={counts} retry={counts.retry}>
        {(data) => (
          <div className="scr-tiles">
            {data.rows.map((r) => (
              <StatTile key={String(r.metric)} label={String(r.metric).replace(/_/g, " ")} value={r.value as number | string | null} data={data} />
            ))}
          </div>
        )}
      </ToolSection>
      <label className="scr-muted">
        Stage{" "}
        <select value={stage} onChange={(e) => setStage(e.target.value as typeof stage)}>
          <option value="">All</option>
          {STAGES.map((s) => (
            <option key={s} value={s}>
              {s}
            </option>
          ))}
        </select>
      </label>
      <ToolSection title="Pipeline" note="One row per pre-screen, newest first (visible to super admin, Site Medical Head and HR)." state={pipeline} retry={pipeline.retry}>
        {(data) => (
          <DataTable
            data={data}
            columns={data.columns.filter((c) => c !== "prescreen_id")}
            rowHref={(row) => (row.prescreen_id ? `/onboarding/${String(row.prescreen_id)}` : null)}
            renderCell={{
              full_name: (v, row) => (row.prescreen_id ? <a href={`${BASE_PATH}/onboarding/${String(row.prescreen_id)}`}>{cell(v)}</a> : cell(v)),
            }}
            empty="No VC pipeline entries."
          />
        )}
      </ToolSection>
    </ScreenFrame>
  );
}

// ---- One pre-screen (the /onboarding/[id] page) -----------------------------------------------------

export function OnboardingPrescreenScreen({ id }: { id: string }) {
  const summaryParams = useMemo<OnboardingReadParams<"onboarding_prescreen">>(() => ({ prescreen_id: id, section: "summary" }), [id]);
  const obsParams = useMemo<OnboardingReadParams<"onboarding_prescreen">>(() => ({ prescreen_id: id, section: "observations" }), [id]);
  const summary = useOnboardingTool("onboarding_prescreen", summaryParams);
  const obs = useOnboardingTool("onboarding_prescreen", obsParams);
  const hospitals = useOnboardingTool("onboarding_hospitals", {});
  const [pending, setPending] = useState<Pending | null>(null);
  const [d, setD] = useState({ decision: "confirm_privileges" as "confirm_privileges" | "extend_observation" | "terminate", rationale: "" });
  const [o, setO] = useState({ case_date: "", procedure: "", observer_role: "", hospital_id: "", flag: "none" as "none" | "concern" | "immediate_termination_recommended", notes: "" });
  const [scores, setScores] = useState<Record<string, string>>(Object.fromEntries(SCORE_DIMENSIONS.map((k) => [k, "3"])));
  useOnboardingContext("onboarding_prescreen", { prescreen_id: id }, {}, [
    { tool: "onboarding_prescreen", params: summaryParams, state: summary },
    { tool: "onboarding_prescreen", params: obsParams, state: obs },
  ]);
  const reload = () => { summary.retry(); obs.retry(); };

  const reviewDecision = (e: { preventDefault: () => void }) => {
    e.preventDefault();
    if (!d.rationale.trim()) return;
    setPending({ action: "prescreen_decision", params: { prescreen_id: id, decision: d.decision, rationale: d.rationale.trim() }, summary: [["Pre-screen", id], ["Decision", d.decision.replace(/_/g, " ")], ["Rationale", d.rationale.trim()]] });
  };
  const reviewObservation = (e: { preventDefault: () => void }) => {
    e.preventDefault();
    if (!UUID.test(o.hospital_id) || !o.case_date || !o.procedure.trim() || !o.observer_role.trim()) return;
    const sc = Object.fromEntries(SCORE_DIMENSIONS.map((k) => [k, Number(scores[k])])) as Record<(typeof SCORE_DIMENSIONS)[number], number>;
    setPending({
      action: "observation_add",
      params: { prescreen_id: id, case_date: o.case_date, procedure: o.procedure.trim(), observer_role: o.observer_role.trim(), hospital_id: o.hospital_id, scores: sc, narrative_notes: nullable(o.notes), flag_severity: o.flag },
      summary: [["Case date", o.case_date], ["Procedure", o.procedure.trim()], ["Observer role", o.observer_role.trim()], ["Hospital", o.hospital_id], ...SCORE_DIMENSIONS.map((k): [string, ReactNode] => [k.replace(/_/g, " "), sc[k]]), ["Flag", o.flag], ["Notes", nullable(o.notes) ? "attached" : null]],
    });
  };
  return (
    <ScreenFrame title="VC pre-screen">
      <OnboardingSubnav current="/onboarding" />
      <ToolSection title="Summary" state={summary} retry={summary.retry}>
        {(data) => <DataTable data={data} columns={["metric", "value"]} empty="Not found." />}
      </ToolSection>
      <ToolSection title="Observation cases" note="Scores 1–5. Case narrative is not shown here." state={obs} retry={obs.retry}>
        {(data) => <DataTable data={data} columns={data.columns} empty="No observation cases yet." />}
      </ToolSection>
      <form className="scr-filters scr-form" onSubmit={reviewDecision} aria-label="Record a decision">
        <Field label="Decision">
          <select value={d.decision} onChange={(e) => setD({ ...d, decision: e.target.value as typeof d.decision })}>
            <option value="confirm_privileges">Confirm privileges</option>
            <option value="extend_observation">Extend observation</option>
            <option value="terminate">Terminate</option>
          </select>
        </Field>
        <Field label="Rationale">
          <input value={d.rationale} onChange={(e) => setD({ ...d, rationale: e.target.value })} maxLength={1000} required />
        </Field>
        <button type="submit">Review decision</button>
      </form>
      <form className="scr-filters scr-form" onSubmit={reviewObservation} aria-label="Add an observation case">
        <Field label="Hospital">
          <select value={o.hospital_id} onChange={(e) => setO({ ...o, hospital_id: e.target.value })} required>
            <option value="">Select…</option>
            {hospitals.status === "ok" && hospitals.data.rows.map((h) => <option key={String(h.hospital_id)} value={String(h.hospital_id)}>{cell(h.code)}</option>)}
          </select>
        </Field>
        <Field label="Case date">
          <input type="date" value={o.case_date} onChange={(e) => setO({ ...o, case_date: e.target.value })} required />
        </Field>
        <Field label="Procedure">
          <input value={o.procedure} onChange={(e) => setO({ ...o, procedure: e.target.value })} maxLength={200} required />
        </Field>
        <Field label="Observer role">
          <input value={o.observer_role} onChange={(e) => setO({ ...o, observer_role: e.target.value })} maxLength={80} required />
        </Field>
        {SCORE_DIMENSIONS.map((k) => (
          <Field key={k} label={k.replace(/_/g, " ")}>
            <select value={scores[k]} onChange={(e) => setScores({ ...scores, [k]: e.target.value })}>
              {[1, 2, 3, 4, 5].map((n) => <option key={n} value={n}>{n}</option>)}
            </select>
          </Field>
        ))}
        <Field label="Flag">
          <select value={o.flag} onChange={(e) => setO({ ...o, flag: e.target.value as typeof o.flag })}>
            <option value="none">None</option>
            <option value="concern">Concern</option>
            <option value="immediate_termination_recommended">Immediate termination recommended</option>
          </select>
        </Field>
        <Field label="Narrative notes (no patient identity)">
          <input value={o.notes} onChange={(e) => setO({ ...o, notes: e.target.value })} maxLength={1000} />
        </Field>
        <button type="submit">Review observation</button>
      </form>
      <Pend pending={pending} onClose={() => setPending(null)} onDone={() => { setPending(null); reload(); }} />
    </ScreenFrame>
  );
}

// ---- New pre-screen (the /onboarding/new page) ------------------------------------------------------

const COMMITMENT_LABELS: Record<(typeof COMMITMENT_KEYS)[number], string> = {
  ot_timings: "OT timings and on-time arrival",
  formulary: "Hospital formulary",
  vendor_mou: "Vendor MOUs, no steering",
  rental_equipment: "Rental-equipment policy",
  weekend_protocol: "Weekend and holiday on-call protocol",
};

export function OnboardingNewScreen() {
  const hospitals = useOnboardingTool("onboarding_hospitals", {});
  const [pending, setPending] = useState<Pending | null>(null);
  const [f, setF] = useState({ email: "", name: "", specialty: "", years: "", priors: "", redFlags: "", decision: "invite" as "invite" | "reject", rationale: "", override: false });
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [commit, setCommit] = useState<Record<string, boolean>>({});
  const [done, setDone] = useState(false);
  useOnboardingContext("onboarding_new", {}, {}, [{ tool: "onboarding_hospitals", params: {}, state: hospitals }]);
  const allCommit = COMMITMENT_KEYS.every((k) => commit[k]);
  const toggle = (code: string) => setPicked((s) => { const n = new Set(s); if (n.has(code)) n.delete(code); else n.add(code); return n; });

  const review = (e: { preventDefault: () => void }) => {
    e.preventDefault();
    setDone(false);
    if (picked.size === 0 || !f.name.trim() || !f.email.trim()) return;
    if (f.decision === "invite" && !allCommit) return;
    if (f.decision === "reject" && !f.rationale.trim()) return;
    const years = f.years.trim() === "" || !Number.isFinite(Number(f.years)) ? null : Math.round(Number(f.years));
    const priors = f.priors.split(",").map((s) => s.trim()).filter(Boolean);
    const params: OnboardingWriteParams<"prescreen_create"> = {
      prospective_email: f.email.trim(),
      prospective_full_name: f.name.trim(),
      prospective_specialty: nullable(f.specialty),
      hospital_codes: [...picked],
      years_post_postgraduate: years,
      prior_corporate_hospitals: priors,
      commitments_acknowledged: Object.fromEntries(COMMITMENT_KEYS.map((k) => [k, commit[k] === true])) as Record<(typeof COMMITMENT_KEYS)[number], boolean>,
      red_flags: nullable(f.redFlags),
      decision: f.decision,
      decision_rationale: nullable(f.rationale),
      cooldown_override: f.override,
    };
    setPending({
      action: "prescreen_create",
      params,
      summary: [["Name", params.prospective_full_name], ["Email", params.prospective_email], ["Specialty", params.prospective_specialty ?? null], ["Hospitals", params.hospital_codes.join(", ")], ["Years post PG", years], ["Prior corporate hospitals", priors.join(", ")], ["Red flags", params.red_flags ?? null], ["Decision", f.decision], ["Rationale", params.decision_rationale ?? null], ["Cooldown override", String(f.override)]],
    });
  };
  return (
    <ScreenFrame title="New VC pre-screen">
      <OnboardingSubnav current="/onboarding/new" />
      <ToolSection title="Pre-screen" note="Reviewing builds a confirm card; nothing is saved until you confirm." state={hospitals} retry={hospitals.retry}>
        {(data) => (
          <form className="scr-filters scr-form" onSubmit={review} aria-label="New pre-screen">
            <Field label="Email">
              <input type="email" value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} maxLength={200} required />
            </Field>
            <Field label="Full name">
              <input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} maxLength={120} required />
            </Field>
            <Field label="Specialty">
              <input value={f.specialty} onChange={(e) => setF({ ...f, specialty: e.target.value })} maxLength={80} />
            </Field>
            <fieldset>
              <legend>Hospitals</legend>
              {data.rows.map((h) => (
                <label key={String(h.code)} className="scr-muted">
                  <input type="checkbox" checked={picked.has(String(h.code))} onChange={() => toggle(String(h.code))} /> {cell(h.code)}
                </label>
              ))}
            </fieldset>
            <Field label="Years post postgraduate">
              <input value={f.years} onChange={(e) => setF({ ...f, years: e.target.value })} inputMode="numeric" />
            </Field>
            <Field label="Prior corporate hospitals (comma separated)">
              <input value={f.priors} onChange={(e) => setF({ ...f, priors: e.target.value })} />
            </Field>
            <Field label="Red flags">
              <input value={f.redFlags} onChange={(e) => setF({ ...f, redFlags: e.target.value })} maxLength={1000} />
            </Field>
            <fieldset>
              <legend>Commitments acknowledged (all required to invite)</legend>
              {COMMITMENT_KEYS.map((k) => (
                <label key={k} className="scr-muted">
                  <input type="checkbox" checked={commit[k] === true} onChange={(e) => setCommit({ ...commit, [k]: e.target.checked })} /> {COMMITMENT_LABELS[k]}
                </label>
              ))}
            </fieldset>
            <Field label="Decision">
              <select value={f.decision} onChange={(e) => setF({ ...f, decision: e.target.value as typeof f.decision })}>
                <option value="invite">Invite to observation</option>
                <option value="reject">Reject</option>
              </select>
            </Field>
            <Field label="Rationale (required to reject)">
              <input value={f.rationale} onChange={(e) => setF({ ...f, rationale: e.target.value })} maxLength={1000} />
            </Field>
            <label className="scr-muted">
              <input type="checkbox" checked={f.override} onChange={(e) => setF({ ...f, override: e.target.checked })} /> Cooldown override (super admin only)
            </label>
            <button type="submit">Review pre-screen</button>
          </form>
        )}
      </ToolSection>
      {done && <p className="scr-muted" role="status">Pre-screen created. It appears in the pipeline.</p>}
      <Pend pending={pending} onClose={() => setPending(null)} onDone={() => { setPending(null); setDone(true); }} />
    </ScreenFrame>
  );
}

// ---- Credentials pending verification ---------------------------------------------------------------

export function OnboardingCredentialsScreen() {
  const params = useMemo<OnboardingReadParams<"onboarding_pending_credentials">>(() => ({ limit: 200 }), []);
  const creds = useOnboardingTool("onboarding_pending_credentials", params);
  useOnboardingContext("onboarding_credentials", {}, {}, [{ tool: "onboarding_pending_credentials", params, state: creds }]);
  return (
    <ScreenFrame title="Credentials pending verification">
      <OnboardingSubnav current="/onboarding/credentials" />
      <ToolSection title="Unverified qualifications" note="Network-wide. Verifying stays in even-elo (super admin, HR, Site Medical Head)." state={creds} retry={creds.retry}>
        {(data) => <DataTable data={data} columns={data.columns.filter((c) => c !== "qualification_id" && c !== "physician_id")} empty="All qualifications are verified." />}
      </ToolSection>
    </ScreenFrame>
  );
}
