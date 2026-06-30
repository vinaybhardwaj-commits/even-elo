"use client";

import { useEffect, useState } from "react";

type KN = { k: string; n: number };
type Stats = {
  totals: { total: number; open: number; near_miss: number; high_sev: number };
  capa: { rcas: number; verified: number; closed: number };
  bySeverity: KN[]; byStatus: KN[]; byType: KN[]; byDept: KN[];
};

const SEV_COLOR: Record<string, string> = { negligible: "#94a3b8", minor: "#3b82f6", moderate: "#d97706", major: "#ea580c", catastrophic: "#dc2626", unrated: "#cbd5e1" };

export default function Dashboard() {
  const [s, setS] = useState<Stats | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);

  useEffect(() => {
    fetch("/api/safety/office/stats").then((r) => r.json()).then((j) => { if (j.ok) setS(j); else setErr(j.error || "Failed"); }).catch(() => setErr("Failed"));
  }, []);

  async function testAlert() {
    setNote("Sending test…");
    try {
      const j = await fetch("/api/safety/office/notify/test", { method: "POST" }).then((r) => r.json());
      setNote(j.ok ? "✅ Test WhatsApp sent." : `Not sent: ${j.error || j.reason || "unknown"}`);
    } catch { setNote("Request failed."); }
  }

  const Bars = ({ title, rows, color }: { title: string; rows: KN[]; color?: (k: string) => string }) => {
    const max = Math.max(1, ...rows.map((r) => r.n));
    return (
      <section style={S.card}>
        <div style={S.flabel}>{title}</div>
        {rows.map((r) => (
          <div key={r.k} style={S.barRow}>
            <div style={S.barK}>{r.k}</div>
            <div style={S.barTrack}><div style={{ ...S.barFill, width: `${(r.n / max) * 100}%`, background: color ? color(r.k) : "#2b5191" }} /></div>
            <div style={S.barN}>{r.n}</div>
          </div>
        ))}
      </section>
    );
  };

  return (
    <main style={S.wrap}>
      <div style={S.head}>
        <div><div style={S.kicker}>EHRC Incident — Safety Office</div><h1 style={S.h1}>Dashboard</h1></div>
        <div style={S.nav}>
          <a href="/safety" style={S.link}>Queue</a>
          <a href="/safety/trends" style={S.link}>Recurring patterns</a>
          <a href="/safety/routes" style={S.link}>Notifications</a>
          <button style={S.test} onClick={testAlert}>Test WhatsApp alert</button>
        </div>
      </div>
      {note && <div style={S.note}>{note}</div>}
      {err && <div style={S.err}>{err}</div>}
      {!s && !err && <div style={S.muted}>Loading…</div>}

      {s && (
        <>
          <div style={S.cards}>
            <div style={S.kpi}><div style={S.kpiN}>{s.totals.total}</div><div style={S.kpiL}>Incidents</div></div>
            <div style={S.kpi}><div style={S.kpiN}>{s.totals.open}</div><div style={S.kpiL}>Open</div></div>
            <div style={S.kpi}><div style={S.kpiN}>{s.totals.total ? Math.round((s.totals.near_miss / s.totals.total) * 100) : 0}%</div><div style={S.kpiL}>Near-miss</div></div>
            <div style={{ ...S.kpi, borderColor: s.totals.high_sev ? "#fecaca" : "#e6eaf0" }}><div style={{ ...S.kpiN, color: s.totals.high_sev ? "#dc2626" : "#0f172a" }}>{s.totals.high_sev}</div><div style={S.kpiL}>Major+</div></div>
            <div style={S.kpi}><div style={S.kpiN}>{s.capa.verified}/{s.capa.rcas}</div><div style={S.kpiL}>CAPAs verified</div></div>
          </div>

          <div style={S.grid}>
            <Bars title="By severity" rows={s.bySeverity} color={(k) => SEV_COLOR[k] || "#2b5191"} />
            <Bars title="By status" rows={s.byStatus} />
            <Bars title="By type" rows={s.byType} />
            <Bars title="By department" rows={s.byDept} />
          </div>
        </>
      )}
    </main>
  );
}

const S: Record<string, React.CSSProperties> = {
  wrap: { maxWidth: 980, margin: "0 auto", padding: "28px 20px", color: "#0f172a" },
  head: { display: "flex", alignItems: "flex-end", justifyContent: "space-between", marginBottom: 18, flexWrap: "wrap", gap: 10 },
  kicker: { fontSize: 12, fontWeight: 700, letterSpacing: ".04em", textTransform: "uppercase", color: "#94a3b8" },
  h1: { fontSize: 26, margin: "4px 0 0" },
  nav: { display: "flex", alignItems: "center", gap: 14 },
  link: { color: "#2b5191", fontSize: 13, fontWeight: 600, textDecoration: "none" },
  test: { padding: "8px 13px", fontSize: 13, fontWeight: 600, color: "#15803d", background: "#dcfce7", border: "1px solid #bbf7d0", borderRadius: 9, cursor: "pointer" },
  note: { fontSize: 13.5, color: "#64748b", marginBottom: 12 },
  cards: { display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))", gap: 12, marginBottom: 18 },
  kpi: { background: "#fff", border: "1px solid #e6eaf0", borderRadius: 12, padding: "16px 18px" },
  kpiN: { fontSize: 28, fontWeight: 800 },
  kpiL: { fontSize: 13, color: "#94a3b8", marginTop: 2 },
  grid: { display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(320px, 1fr))", gap: 14 },
  card: { background: "#fff", border: "1px solid #e6eaf0", borderRadius: 12, padding: "16px 18px" },
  flabel: { fontSize: 12, fontWeight: 700, letterSpacing: ".03em", textTransform: "uppercase", color: "#94a3b8", marginBottom: 10 },
  barRow: { display: "flex", alignItems: "center", gap: 10, margin: "6px 0" },
  barK: { flex: "0 0 140px", fontSize: 13, color: "#334155", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" },
  barTrack: { flex: 1, height: 10, background: "#f1f5f9", borderRadius: 5, overflow: "hidden" },
  barFill: { height: "100%", borderRadius: 5 },
  barN: { flex: "0 0 28px", textAlign: "right", fontSize: 13, fontWeight: 600 },
  muted: { color: "#94a3b8", fontSize: 14, padding: "20px 0" },
  err: { color: "#dc2626", fontSize: 14, padding: "12px 0" },
};
