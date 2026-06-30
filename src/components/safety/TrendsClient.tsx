"use client";

import { useEffect, useState } from "react";

type Cluster = { id: string; label: string; recurrence_count: number; risk_score: number | null; last_seen: string | null; member_count: number; rca_count: number };

export default function Trends() {
  const [clusters, setClusters] = useState<Cluster[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [scanning, setScanning] = useState(false);
  const [note, setNote] = useState<string | null>(null);

  function load() {
    fetch("/api/safety/office/clusters").then((r) => r.json()).then((j) => {
      if (j.ok) setClusters(j.clusters); else setErr(j.error || "Failed to load");
    }).catch(() => setErr("Failed to load"));
  }
  useEffect(load, []);

  async function scan() {
    setScanning(true); setNote("Embedding & clustering incidents…");
    try {
      const j = await fetch("/api/safety/office/recurrence/scan", { method: "POST" }).then((r) => r.json());
      if (j.ok) { setNote(`Scanned ${j.processed} — ${j.matched} matched, ${j.created} new clusters.`); load(); }
      else setNote(j.error || "Scan failed.");
    } catch { setNote("Scan failed."); }
    finally { setScanning(false); }
  }

  const max = Math.max(1, ...(clusters || []).map((c) => c.recurrence_count));

  return (
    <main style={S.wrap}>
      <div style={S.head}>
        <div><div style={S.kicker}>EHRC Incident — Safety Office</div><h1 style={S.h1}>Recurring patterns</h1></div>
        <div style={S.actions}>
          <a href="/safety" style={S.link}>← Queue</a>
          <button style={{ ...S.scan, opacity: scanning ? 0.6 : 1 }} onClick={scan} disabled={scanning}>{scanning ? "Scanning…" : "Scan now"}</button>
        </div>
      </div>
      {note && <div style={S.note}>{note}</div>}
      {err && <div style={S.err}>{err}</div>}
      {!clusters && !err && <div style={S.muted}>Loading…</div>}
      {clusters && clusters.length === 0 && <div style={S.muted}>No clusters yet — run a scan to detect recurring patterns.</div>}

      <div style={S.list}>
        {(clusters || []).map((c) => (
          <div key={c.id} style={S.row}>
            <div style={S.barWrap}><div style={{ ...S.bar, width: `${(c.recurrence_count / max) * 100}%`, background: c.recurrence_count >= 3 ? "#dc2626" : c.recurrence_count >= 2 ? "#ea580c" : "#94a3b8" }} /></div>
            <div style={S.rowMain}>
              <div style={S.label}>{c.label}</div>
              <div style={S.meta}>{c.recurrence_count}× · {c.rca_count} with RCA · risk {c.risk_score ?? "—"}{c.last_seen ? ` · last ${new Date(c.last_seen).toLocaleDateString()}` : ""}</div>
            </div>
            <div style={{ ...S.count, color: c.recurrence_count >= 3 ? "#dc2626" : c.recurrence_count >= 2 ? "#ea580c" : "#64748b" }}>{c.recurrence_count}</div>
          </div>
        ))}
      </div>
    </main>
  );
}

const S: Record<string, React.CSSProperties> = {
  wrap: { maxWidth: 880, margin: "0 auto", padding: "28px 20px", color: "#0f172a" },
  head: { display: "flex", alignItems: "flex-end", justifyContent: "space-between", marginBottom: 16, flexWrap: "wrap", gap: 10 },
  kicker: { fontSize: 12, fontWeight: 700, letterSpacing: ".04em", textTransform: "uppercase", color: "#94a3b8" },
  h1: { fontSize: 26, margin: "4px 0 0" },
  actions: { display: "flex", alignItems: "center", gap: 14 },
  link: { color: "#2b5191", fontSize: 13, textDecoration: "none" },
  scan: { padding: "9px 16px", fontSize: 14, fontWeight: 600, color: "#fff", background: "#7c3aed", border: "none", borderRadius: 10, cursor: "pointer" },
  note: { fontSize: 13.5, color: "#64748b", marginBottom: 12 },
  list: { display: "flex", flexDirection: "column", gap: 8 },
  row: { display: "flex", alignItems: "center", gap: 14, background: "#fff", border: "1px solid #e6eaf0", borderRadius: 12, padding: "12px 16px" },
  barWrap: { flex: "0 0 120px", height: 8, background: "#f1f5f9", borderRadius: 4, overflow: "hidden" },
  bar: { height: "100%", borderRadius: 4 },
  rowMain: { flex: 1 },
  label: { fontSize: 15, fontWeight: 600 },
  meta: { fontSize: 12.5, color: "#94a3b8", marginTop: 2 },
  count: { fontSize: 22, fontWeight: 800, flex: "0 0 auto" },
  muted: { color: "#94a3b8", fontSize: 14, padding: "20px 0" },
  err: { color: "#dc2626", fontSize: 14, padding: "12px 0" },
};
