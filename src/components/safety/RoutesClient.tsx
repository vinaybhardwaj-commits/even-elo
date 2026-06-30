"use client";

import { useEffect, useState } from "react";

type Target = { to: string; name?: string };
type Route = { id: string; label: string; match_field: string; match_value: string | null; targets: Target[]; active: boolean };
type Meta = { types: { name: string }[]; departments: { name: string }[] };

const FIELDS: [string, string][] = [
  ["any", "All incidents"], ["category", "Category is…"], ["type", "Type is…"],
  ["department", "Department is…"], ["severity", "Severity is…"], ["severity_min", "Severity at least…"],
];
const SEVS = ["negligible", "minor", "moderate", "major", "catastrophic"];
const CATS = ["clinical", "non_clinical"];

export default function Routes() {
  const [routes, setRoutes] = useState<Route[]>([]);
  const [meta, setMeta] = useState<Meta | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);

  function load() {
    fetch("/api/safety/office/routes").then((r) => r.json()).then((j) => { if (j.ok) { setRoutes(j.routes.map((r: Route) => ({ ...r, targets: r.targets || [] }))); setLoaded(true); } });
    fetch("/api/safety/incident/meta").then((r) => r.json()).then((j) => { if (j.ok) setMeta({ types: j.types, departments: j.departments }); });
  }
  useEffect(load, []);

  const upd = (i: number, patch: Partial<Route>) => setRoutes((rs) => rs.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  const updTarget = (i: number, k: number, patch: Partial<Target>) => upd(i, { targets: routes[i].targets.map((t, m) => (m === k ? { ...t, ...patch } : t)) });

  async function save(i: number) {
    const r = routes[i];
    setNote("Saving…");
    const j = await fetch(`/api/safety/office/routes/${r.id}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ label: r.label, match_field: r.match_field, match_value: r.match_value, targets: r.targets.filter((t) => t.to.trim()), active: r.active }) }).then((x) => x.json());
    setNote(j.ok ? "Saved." : `Error: ${j.error}`);
  }
  async function del(i: number) {
    const r = routes[i];
    await fetch(`/api/safety/office/routes/${r.id}`, { method: "DELETE" });
    setRoutes((rs) => rs.filter((_, j) => j !== i));
  }
  async function add() {
    const j = await fetch("/api/safety/office/routes", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ label: "New rule", match_field: "any", targets: [], active: false }) }).then((x) => x.json());
    if (j.ok) load();
  }
  async function testAll() {
    setNote("Sending test…");
    const j = await fetch("/api/safety/office/notify/test", { method: "POST" }).then((x) => x.json());
    setNote(j.ok ? `✅ Test sent to ${j.sent}/${j.attempted} recipient(s).` : `Not sent: ${j.error || j.reason}`);
  }

  const valueOptions = (field: string): string[] | null =>
    field === "category" ? CATS : field === "type" ? (meta?.types || []).map((t) => t.name)
    : field === "department" ? (meta?.departments || []).map((d) => d.name) : (field === "severity" || field === "severity_min") ? SEVS : null;

  return (
    <main style={S.wrap}>
      <div style={S.head}>
        <div><div style={S.kicker}>EHRC Incident — Safety Office</div><h1 style={S.h1}>Notification routing</h1></div>
        <div style={S.nav}><a href="/safety" style={S.link}>Queue</a><a href="/safety/dashboard" style={S.link}>Dashboard</a><button style={S.test} onClick={testAll}>Send test</button></div>
      </div>
      <p style={S.intro}>Each rule fans an alert out to its recipients when an incident matches. A recipient is a phone number (E.164, e.g. +9163…) or a WhatsApp group id (…@g.us). Rules combine — an incident notifies everyone in every matching rule. Inactive rules are ignored.</p>
      {note && <div style={S.note}>{note}</div>}

      {loaded && routes.length === 0 && <div style={S.muted}>No rules yet.</div>}

      {routes.map((r, i) => {
        const opts = valueOptions(r.match_field);
        return (
          <section key={r.id} style={{ ...S.card, opacity: r.active ? 1 : 0.7 }}>
            <div style={S.cardTop}>
              <input style={S.label} value={r.label} onChange={(e) => upd(i, { label: e.target.value })} />
              <label style={S.activeRow}><input type="checkbox" checked={r.active} onChange={(e) => upd(i, { active: e.target.checked })} /> active</label>
            </div>
            <div style={S.matchRow}>
              <span style={S.when}>When</span>
              <select style={S.sel} value={r.match_field} onChange={(e) => upd(i, { match_field: e.target.value, match_value: "" })}>
                {FIELDS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
              </select>
              {opts && (
                <select style={S.sel} value={r.match_value || ""} onChange={(e) => upd(i, { match_value: e.target.value })}>
                  <option value="">Select…</option>{opts.map((o) => <option key={o} value={o}>{o}</option>)}
                </select>
              )}
            </div>
            <div style={S.flabel}>Notify</div>
            {r.targets.map((t, k) => (
              <div key={k} style={S.tRow}>
                <input style={S.tTo} placeholder="+9163… or group@g.us" value={t.to} onChange={(e) => updTarget(i, k, { to: e.target.value })} />
                <input style={S.tName} placeholder="name (optional)" value={t.name || ""} onChange={(e) => updTarget(i, k, { name: e.target.value })} />
                <button style={S.x} onClick={() => upd(i, { targets: r.targets.filter((_, m) => m !== k) })}>✕</button>
              </div>
            ))}
            <button style={S.add} onClick={() => upd(i, { targets: [...r.targets, { to: "", name: "" }] })}>+ Add recipient</button>
            <div style={S.cardFoot}>
              <button style={S.save} onClick={() => save(i)}>Save</button>
              <button style={S.del} onClick={() => del(i)}>Delete</button>
            </div>
          </section>
        );
      })}

      <button style={S.addRule} onClick={add}>+ Add rule</button>
    </main>
  );
}

const S: Record<string, React.CSSProperties> = {
  wrap: { maxWidth: 760, margin: "0 auto", padding: "28px 20px 60px", color: "#0f172a" },
  head: { display: "flex", alignItems: "flex-end", justifyContent: "space-between", marginBottom: 10, flexWrap: "wrap", gap: 10 },
  kicker: { fontSize: 12, fontWeight: 700, letterSpacing: ".04em", textTransform: "uppercase", color: "#94a3b8" },
  h1: { fontSize: 26, margin: "4px 0 0" },
  nav: { display: "flex", alignItems: "center", gap: 14 },
  link: { color: "#2b5191", fontSize: 13, fontWeight: 600, textDecoration: "none" },
  test: { padding: "8px 13px", fontSize: 13, fontWeight: 600, color: "#15803d", background: "#dcfce7", border: "1px solid #bbf7d0", borderRadius: 9, cursor: "pointer" },
  intro: { color: "#64748b", fontSize: 13.5, lineHeight: 1.6, margin: "6px 0 14px" },
  note: { fontSize: 13.5, color: "#334155", background: "#f1f5f9", borderRadius: 8, padding: "8px 12px", marginBottom: 12 },
  card: { background: "#fff", border: "1px solid #e6eaf0", borderRadius: 12, padding: "14px 16px", marginBottom: 12 },
  cardTop: { display: "flex", gap: 10, alignItems: "center" },
  label: { flex: 1, padding: "9px 11px", fontSize: 15, fontWeight: 600, border: "1px solid #cbd5e1", borderRadius: 9 },
  activeRow: { display: "flex", alignItems: "center", gap: 6, fontSize: 13, color: "#475569", flex: "0 0 auto" },
  matchRow: { display: "flex", gap: 8, alignItems: "center", margin: "10px 0", flexWrap: "wrap" },
  when: { fontSize: 13, color: "#94a3b8" },
  sel: { padding: "8px 10px", fontSize: 14, border: "1px solid #cbd5e1", borderRadius: 9, background: "#fff" },
  flabel: { fontSize: 12, fontWeight: 700, letterSpacing: ".03em", textTransform: "uppercase", color: "#94a3b8", margin: "6px 0" },
  tRow: { display: "flex", gap: 8, alignItems: "center", marginBottom: 7 },
  tTo: { flex: "1 1 200px", padding: "8px 10px", fontSize: 14, border: "1px solid #cbd5e1", borderRadius: 9, fontFamily: "ui-monospace, Menlo, monospace" },
  tName: { flex: "1 1 120px", padding: "8px 10px", fontSize: 14, border: "1px solid #cbd5e1", borderRadius: 9 },
  x: { border: "none", background: "transparent", color: "#94a3b8", cursor: "pointer", fontSize: 14, flex: "0 0 auto" },
  add: { marginTop: 2, padding: "6px 10px", fontSize: 13, fontWeight: 600, color: "#2b5191", background: "#eef2fb", border: "1px solid #dbe4f5", borderRadius: 8, cursor: "pointer" },
  cardFoot: { display: "flex", gap: 10, marginTop: 12 },
  save: { padding: "8px 16px", fontSize: 14, fontWeight: 600, color: "#fff", background: "#16a34a", border: "none", borderRadius: 9, cursor: "pointer" },
  del: { padding: "8px 14px", fontSize: 13, fontWeight: 600, color: "#b91c1c", background: "#fee2e2", border: "1px solid #fecaca", borderRadius: 9, cursor: "pointer" },
  addRule: { marginTop: 6, padding: "11px 18px", fontSize: 15, fontWeight: 600, color: "#fff", background: "#2b5191", border: "none", borderRadius: 10, cursor: "pointer" },
  muted: { color: "#94a3b8", fontSize: 14, padding: "12px 0" },
};
