"use client";

import { useEffect, useState } from "react";
import { useParams } from "next/navigation";

type Inc = Record<string, unknown>;
type Rca = Record<string, unknown>;

const SEV_COLOR: Record<string, string> = { negligible: "#94a3b8", minor: "#3b82f6", moderate: "#d97706", major: "#ea580c", catastrophic: "#dc2626" };
const STATUS = [["open", "Open"], ["under_investigation", "Investigating"], ["capa_assigned", "CAPA assigned"], ["closed", "Closed"], ["verified", "Verified"]];

export default function IncidentDetail() {
  const { id } = useParams<{ id: string }>();
  const [inc, setInc] = useState<Inc | null>(null);
  const [rcas, setRcas] = useState<Rca[]>([]);
  const [cluster, setCluster] = useState<Record<string, unknown> | null>(null);
  const [siblings, setSiblings] = useState<Record<string, unknown>[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const [owner, setOwner] = useState("");
  const [saving, setSaving] = useState<string | null>(null);

  function load() {
    fetch(`/api/safety/office/incidents/${id}`).then((r) => r.json()).then((j) => {
      if (j.ok) { setInc(j.incident); setRcas(j.rcas || []); setCluster(j.cluster || null); setSiblings(j.siblings || []); setOwner((j.incident.owner_name as string) || ""); }
      else setErr(j.error || "Failed to load");
    }).catch(() => setErr("Failed to load"));
  }
  useEffect(load, [id]);

  async function patch(body: Record<string, unknown>, tag: string) {
    setSaving(tag);
    try { await fetch(`/api/safety/office/incidents/${id}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }); load(); }
    finally { setSaving(null); }
  }

  async function patchRca(rcaId: string, action: string) {
    setSaving("rca");
    try { await fetch(`/api/safety/office/rca/${rcaId}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action }) }); load(); }
    finally { setSaving(null); }
  }

  if (err) return <main style={S.wrap}><a href="/safety" style={S.back}>← Queue</a><div style={S.err}>{err}</div></main>;
  if (!inc) return <main style={S.wrap}><div style={S.muted}>Loading…</div></main>;

  const g = (k: string) => (inc[k] == null ? null : String(inc[k]));
  const sev = g("severity");
  const conf = g("confidentiality");
  const hasPatient = g("phi_patient_name") || g("phi_uhid") || g("phi_patient_age");

  const Field = ({ label, value }: { label: string; value: React.ReactNode }) =>
    value ? <div style={S.field}><div style={S.flabel}>{label}</div><div style={S.fvalue}>{value}</div></div> : null;

  return (
    <main style={S.wrap}>
      <a href="/safety" style={S.back}>← Queue</a>

      <div style={S.headRow}>
        <span style={{ ...S.sevDot, background: SEV_COLOR[sev || ""] || "#cbd5e1" }} />
        <h1 style={S.id}>{g("id")}</h1>
        {g("near_miss") === "true" && <span style={S.nearMiss}>near miss</span>}
        <span style={S.sevTag}>{sev || "unrated"}</span>
      </div>
      <div style={S.subhead}>{g("type_name") || "Unclassified"} · {g("dept_name") || "—"}{g("location_name") ? ` · ${g("location_name")}` : ""}</div>

      {cluster && Number(cluster.recurrence_count) >= 2 && (() => {
        const priorCapas = siblings.flatMap((s) => ((s.rcas as { capas?: { action: string; control_level: string }[] }[]) || []).flatMap((r) => r.capas || [])).filter(Boolean);
        return (
          <section style={S.recur}>
            <div style={S.recurHead}>🔁 Recurring — {String(cluster.recurrence_count)} occurrences of “{String(cluster.label)}”</div>
            {priorCapas.length > 0 ? (
              <div style={S.recurBody}>
                <div style={S.recurLabel}>Prior CAPAs on this pattern — did they hold?</div>
                {priorCapas.map((c, i) => (
                  <div key={i} style={S.recurCapa}>• {c.action}<span style={{ fontWeight: 600, color: c.control_level === "training" || c.control_level === "ppe" ? "#b45309" : "#15803d" }}> · {c.control_level}</span></div>
                ))}
              </div>
            ) : <div style={S.recurBody}>No prior CAPA recorded on this pattern yet.</div>}
          </section>
        );
      })()}

      <section style={S.card}>
        <div style={S.flabel}>What happened</div>
        <p style={S.narrative}>{g("narrative")}</p>
        <Field label="Immediate action taken" value={g("immediate_action")} />
      </section>

      <section style={S.grid}>
        <Field label="Who / what affected" value={g("impact_domain")} />
        <Field label="Occurred" value={g("occurred_at") ? new Date(g("occurred_at")!).toLocaleString() : null} />
        <Field label="Reported" value={new Date(g("reported_at")!).toLocaleString()} />
        <Field label="Reporter role" value={g("role_name")} />
        <Field label="Source" value={g("source")} />
        <Field label="Confidentiality" value={conf} />
        <Field label="Reporter" value={conf === "named" ? g("reporter_name") : conf === "confidential" ? `${g("reporter_name") || "—"} (confidential)` : "Anonymous"} />
        <Field label="Reporter contact" value={conf === "confidential" ? g("reporter_contact") : null} />
      </section>

      {hasPatient && (
        <section style={S.card}>
          <div style={S.flabel}>Patient (contained)</div>
          <div style={S.grid}>
            <Field label="Name" value={g("phi_patient_name")} />
            <Field label="UHID" value={g("phi_uhid")} />
            <Field label="Age" value={g("phi_patient_age")} />
            <Field label="Sex" value={g("phi_patient_sex")} />
          </div>
        </section>
      )}

      <section style={S.card}>
        <div style={S.flabel}>Lifecycle</div>
        <div style={S.lifeRow}>
          <select style={S.sel} value={g("status") || "open"} onChange={(e) => patch({ status: e.target.value }, "status")}>
            {STATUS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
          </select>
          <input style={S.owner} placeholder="Assign owner" value={owner} onChange={(e) => setOwner(e.target.value)} />
          <button style={S.btnSm} onClick={() => patch({ owner_name: owner }, "owner")} disabled={saving === "owner"}>Save owner</button>
        </div>
      </section>

      <section style={S.card}>
        <div style={S.rcaHead}>
          <div style={S.flabel}>Root cause & CAPA</div>
          <a href={`/safety/incidents/${id}/rca`} style={{ ...S.btn, textDecoration: "none" }}>{rcas.length ? "Add another RCA" : "Start guided RCA"}</a>
        </div>
        {rcas.length === 0 ? <div style={S.muted}>No RCA yet.</div> : rcas.map((r, i) => {
          const cf = (r.contributory_factors || {}) as { factors?: { category: string; note: string }[]; fiveWhys?: string[] };
          const capas = (r.capas || []) as { kind: string; action: string; control_level: string }[];
          const rcaId = String(r.id);
          return (
            <div key={i} style={S.rcaItem}>
              <div style={S.fvalue}><b>Root cause:</b> {String(r.root_cause || "—")}</div>
              {!!cf.factors?.length && (
                <div style={{ marginTop: 8 }}>
                  <div style={S.flabel}>Contributory factors</div>
                  {cf.factors.map((f, k) => <div key={k} style={S.factLine}><span style={S.factCat}>{f.category}</span> {f.note}</div>)}
                </div>
              )}
              {!!capas.length && (
                <div style={{ marginTop: 8 }}>
                  <div style={S.flabel}>CAPAs</div>
                  {capas.map((c, k) => (
                    <div key={k} style={S.factLine}>
                      <span style={S.kind}>{c.kind}</span> {c.action}
                      <span style={{ ...S.ctrl, color: c.control_level === "training" || c.control_level === "ppe" ? "#b45309" : "#15803d" }}>· {c.control_level}</span>
                    </div>
                  ))}
                </div>
              )}
              <div style={S.rcaFoot}>
                <span style={S.muted}>{r.effectiveness_verified ? "✓ Verified effective" : r.closed_at ? "Closed" : "Open"}</span>
                {!r.closed_at && <button style={S.btnSm} disabled={saving === "rca"} onClick={() => patchRca(rcaId, "close")}>Close</button>}
                {!r.effectiveness_verified && <button style={S.btnSm} disabled={saving === "rca"} onClick={() => patchRca(rcaId, "verify")}>Mark verified</button>}
              </div>
            </div>
          );
        })}
      </section>
    </main>
  );
}

const S: Record<string, React.CSSProperties> = {
  wrap: { maxWidth: 760, margin: "0 auto", padding: "24px 20px 60px", color: "#0f172a" },
  back: { display: "inline-block", color: "#2b5191", fontSize: 13, textDecoration: "none", marginBottom: 14 },
  headRow: { display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" },
  sevDot: { width: 12, height: 12, borderRadius: 6 },
  id: { fontFamily: "ui-monospace, Menlo, monospace", fontSize: 20, margin: 0 },
  nearMiss: { fontSize: 11, fontWeight: 700, color: "#0369a1", background: "#e0f2fe", borderRadius: 6, padding: "2px 7px" },
  sevTag: { fontSize: 12, fontWeight: 700, color: "#475569", background: "#f1f5f9", borderRadius: 6, padding: "3px 9px", textTransform: "capitalize" },
  subhead: { color: "#475569", fontSize: 15, margin: "8px 0 18px" },
  card: { background: "#fff", border: "1px solid #e6eaf0", borderRadius: 12, padding: "16px 18px", marginBottom: 14 },
  narrative: { fontSize: 15, lineHeight: 1.6, color: "#1e293b", margin: "8px 0 0", whiteSpace: "pre-wrap" },
  grid: { display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))", gap: 14, marginBottom: 14 },
  field: {},
  flabel: { fontSize: 12, fontWeight: 700, letterSpacing: ".03em", textTransform: "uppercase", color: "#94a3b8" },
  fvalue: { fontSize: 15, color: "#1e293b", marginTop: 3 },
  lifeRow: { display: "flex", gap: 10, marginTop: 10, flexWrap: "wrap", alignItems: "center" },
  sel: { padding: "9px 12px", fontSize: 14, border: "1px solid #cbd5e1", borderRadius: 9, background: "#fff" },
  owner: { flex: "1 1 160px", padding: "9px 12px", fontSize: 14, border: "1px solid #cbd5e1", borderRadius: 9 },
  btn: { padding: "9px 14px", fontSize: 14, fontWeight: 600, color: "#fff", background: "#2b5191", border: "none", borderRadius: 9, cursor: "pointer" },
  btnSm: { padding: "9px 12px", fontSize: 13, fontWeight: 600, color: "#2b5191", background: "#eef2fb", border: "1px solid #dbe4f5", borderRadius: 9, cursor: "pointer" },
  rcaHead: { display: "flex", justifyContent: "space-between", alignItems: "center", gap: 10, marginBottom: 8 },
  rcaItem: { borderTop: "1px solid #f1f5f9", paddingTop: 10, marginTop: 10 },
  muted: { color: "#94a3b8", fontSize: 14 },
  err: { color: "#dc2626", fontSize: 14 },
  factLine: { fontSize: 14, color: "#1e293b", margin: "4px 0", lineHeight: 1.5 },
  factCat: { fontSize: 11, fontWeight: 700, textTransform: "uppercase", color: "#6d28d9", background: "#ede9fe", borderRadius: 5, padding: "1px 6px", marginRight: 4 },
  kind: { fontSize: 11, fontWeight: 700, textTransform: "uppercase", color: "#475569", background: "#f1f5f9", borderRadius: 5, padding: "1px 6px", marginRight: 4 },
  ctrl: { fontWeight: 600, marginLeft: 4 },
  rcaFoot: { display: "flex", alignItems: "center", gap: 10, marginTop: 10, flexWrap: "wrap" },
  recur: { background: "#fff7ed", border: "1px solid #fed7aa", borderRadius: 12, padding: "14px 16px", marginBottom: 14 },
  recurHead: { fontSize: 15, fontWeight: 700, color: "#9a3412" },
  recurBody: { marginTop: 8, fontSize: 14, color: "#7c2d12" },
  recurLabel: { fontSize: 12, fontWeight: 700, textTransform: "uppercase", color: "#b45309", marginBottom: 4 },
  recurCapa: { fontSize: 13.5, color: "#7c2d12", margin: "3px 0", lineHeight: 1.5 },
};
