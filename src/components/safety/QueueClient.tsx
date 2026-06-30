"use client";

import { useEffect, useMemo, useState } from "react";

type Row = {
  id: string; reported_at: string; severity: string | null; impact_domain: string | null;
  near_miss: boolean; status: string; confidentiality: string; owner_name: string | null;
  narrative_snippet: string; type_name: string | null; type_category: string | null;
  dept_name: string | null; location_name: string | null; rca_count: number;
};

const SEV_COLOR: Record<string, string> = { negligible: "#94a3b8", minor: "#3b82f6", moderate: "#d97706", major: "#ea580c", catastrophic: "#dc2626" };
const STATUS_LABEL: Record<string, string> = { open: "Open", under_investigation: "Investigating", capa_assigned: "CAPA assigned", closed: "Closed", verified: "Verified" };

export default function OfficeQueue() {
  const [rows, setRows] = useState<Row[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [status, setStatus] = useState("");
  const [sev, setSev] = useState("");
  const [q, setQ] = useState("");

  useEffect(() => {
    fetch("/api/safety/office/incidents").then((r) => r.json()).then((j) => {
      if (j.ok) setRows(j.incidents); else setErr(j.error || "Failed to load");
    }).catch(() => setErr("Failed to load"));
  }, []);

  const filtered = useMemo(() => {
    if (!rows) return [];
    const ql = q.trim().toLowerCase();
    return rows.filter((r) =>
      (!status || r.status === status) &&
      (!sev || r.severity === sev) &&
      (!ql || [r.id, r.type_name, r.dept_name, r.location_name, r.narrative_snippet].some((v) => (v || "").toLowerCase().includes(ql)))
    );
  }, [rows, status, sev, q]);

  const openCount = rows?.filter((r) => r.status !== "closed" && r.status !== "verified").length ?? 0;

  return (
    <main style={S.wrap}>
      <div style={S.head}>
        <div>
          <div style={S.kicker}>EHRC Incident — Safety Office</div>
          <h1 style={S.h1}>Incident queue</h1>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
          <a href="/safety/dashboard" style={{ color: "#2b5191", fontSize: 13, fontWeight: 600, textDecoration: "none" }}>Dashboard</a>
          <a href="/safety/trends" style={{ color: "#2b5191", fontSize: 13, fontWeight: 600, textDecoration: "none" }}>Recurring patterns →</a>
          <div style={S.count}>{openCount} open</div>
        </div>
      </div>

      <div style={S.filters}>
        <input style={S.search} placeholder="Search id, type, department, text…" value={q} onChange={(e) => setQ(e.target.value)} />
        <select style={S.sel} value={status} onChange={(e) => setStatus(e.target.value)}>
          <option value="">All statuses</option>
          {Object.entries(STATUS_LABEL).map(([v, l]) => <option key={v} value={v}>{l}</option>)}
        </select>
        <select style={S.sel} value={sev} onChange={(e) => setSev(e.target.value)}>
          <option value="">All severities</option>
          {Object.keys(SEV_COLOR).map((v) => <option key={v} value={v}>{v}</option>)}
        </select>
      </div>

      {err && <div style={S.err}>{err}</div>}
      {!rows && !err && <div style={S.muted}>Loading…</div>}
      {rows && filtered.length === 0 && <div style={S.muted}>No incidents match.</div>}

      <div style={S.list}>
        {filtered.map((r) => (
          <a key={r.id} href={`/safety/incidents/${r.id}`} style={S.card}>
            <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
              <span style={{ ...S.sevDot, background: SEV_COLOR[r.severity || ""] || "#cbd5e1" }} />
              <span style={S.id}>{r.id}</span>
              {r.near_miss && <span style={S.nearMiss}>near miss</span>}
              <span style={S.badge}>{STATUS_LABEL[r.status] || r.status}</span>
              {r.rca_count > 0 && <span style={S.rca}>RCA</span>}
              <span style={S.meta}>{new Date(r.reported_at).toLocaleDateString()}</span>
            </div>
            <div style={S.title}>{r.type_name || "Unclassified"} · {r.dept_name || "—"}{r.location_name ? ` · ${r.location_name}` : ""}</div>
            <div style={S.snippet}>{r.narrative_snippet}</div>
          </a>
        ))}
      </div>
    </main>
  );
}

const S: Record<string, React.CSSProperties> = {
  wrap: { maxWidth: 980, margin: "0 auto", padding: "28px 20px", color: "#0f172a" },
  head: { display: "flex", alignItems: "flex-end", justifyContent: "space-between", marginBottom: 18 },
  kicker: { fontSize: 12, fontWeight: 700, letterSpacing: ".04em", textTransform: "uppercase", color: "#94a3b8" },
  h1: { fontSize: 26, margin: "4px 0 0" },
  count: { fontSize: 14, fontWeight: 600, color: "#2b5191", background: "#eef2fb", borderRadius: 999, padding: "6px 14px" },
  filters: { display: "flex", gap: 10, marginBottom: 16, flexWrap: "wrap" },
  search: { flex: "1 1 280px", padding: "10px 12px", fontSize: 14, border: "1px solid #cbd5e1", borderRadius: 10 },
  sel: { padding: "10px 12px", fontSize: 14, border: "1px solid #cbd5e1", borderRadius: 10, background: "#fff" },
  list: { display: "flex", flexDirection: "column", gap: 10 },
  card: { display: "block", textDecoration: "none", color: "inherit", background: "#fff", border: "1px solid #e6eaf0", borderRadius: 12, padding: "13px 15px", boxShadow: "0 2px 8px rgba(15,23,42,.04)" },
  sevDot: { width: 10, height: 10, borderRadius: 5, display: "inline-block" },
  id: { fontFamily: "ui-monospace, Menlo, monospace", fontSize: 13, fontWeight: 700 },
  nearMiss: { fontSize: 11, fontWeight: 700, color: "#0369a1", background: "#e0f2fe", borderRadius: 6, padding: "2px 7px" },
  badge: { fontSize: 11, fontWeight: 600, color: "#475569", background: "#f1f5f9", borderRadius: 6, padding: "2px 8px" },
  rca: { fontSize: 11, fontWeight: 700, color: "#15803d", background: "#dcfce7", borderRadius: 6, padding: "2px 7px" },
  meta: { marginLeft: "auto", fontSize: 12, color: "#94a3b8" },
  title: { fontSize: 15, fontWeight: 600, marginTop: 8 },
  snippet: { fontSize: 13.5, color: "#64748b", marginTop: 4, lineHeight: 1.5 },
  muted: { color: "#94a3b8", fontSize: 14, padding: "20px 0" },
  err: { color: "#dc2626", fontSize: 14, padding: "12px 0" },
};
