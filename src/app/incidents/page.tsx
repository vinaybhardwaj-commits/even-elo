"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { TopNav } from "@/components/TopNav";

interface Row {
  id: string;
  target_physician_id: string;
  target_physician_name: string;
  submitted_at: string;
  anonymous_flag: boolean;
  submitter_label: string;
  hospital_code: string | null;
  category: string | null;
  severity: string | null;
  polarity: string;
  source: string;
  commendation_category: string | null;
  patient_rating: number | null;
  narrative_preview: string;
  status: string;
  retracted_at: string | null;
  retraction_reason: string | null;
  reply_count: number;
  last_reply_at: string | null;
}

const SEV_PILL: Record<string, string> = {
  low: "bg-stone-100 text-stone-700",
  medium: "bg-amber-50 text-amber-800",
  high: "bg-orange-50 text-orange-800",
  critical: "bg-red-50 text-red-800",
};

const STATUS_PILL: Record<string, string> = {
  open: "bg-emerald-50 text-emerald-700",
  closed: "bg-stone-100 text-stone-600",
  retracted: "bg-red-50 text-red-700",
};

const CATEGORY_LABEL: Record<string, string> = {
  clinical: "Clinical",
  patient_safety: "Patient safety",
  medical_error: "Medical error",
  professionalism: "Professionalism",
  documentation: "Documentation",
  etiquette: "Etiquette",
  vendor_compliance: "Vendor compliance",
  other: "Other",
};

function timeAgo(iso: string): string {
  const t = new Date(iso).getTime();
  const s = Math.max(1, Math.floor((Date.now() - t) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

export default function IncidentsInbox() {
  const [rows, setRows] = useState<Row[]>([]);
  const [counts, setCounts] = useState<Array<{ status: string; severity: string; n: number }>>([]);
  const [loading, setLoading] = useState(true);
  const [status, setStatus] = useState("open");
  const [severity, setSeverity] = useState("");
  const [category, setCategory] = useState("");
  const [polarity, setPolarity] = useState("");
  const [src, setSrc] = useState("");

  function load() {
    setLoading(true);
    const u = new URL("/api/incidents", window.location.origin);
    if (status) u.searchParams.set("status", status);
    if (severity) u.searchParams.set("severity", severity);
    if (category) u.searchParams.set("category", category);
    fetch(u.toString())
      .then((r) => r.json())
      .then((j) => {
        if (j.ok) {
          setRows(j.rows ?? []);
          setCounts(j.counts ?? []);
        }
      })
      .finally(() => setLoading(false));
  }
  useEffect(() => { load(); /* eslint-disable-next-line */ }, [status, severity, category]);

  // Totals across visible scope (sum of counts regardless of current filter)
  const totalByStatus: Record<string, number> = {};
  for (const c of counts) totalByStatus[c.status] = (totalByStatus[c.status] ?? 0) + c.n;
  const visible = rows.filter((r) => (!polarity || r.polarity === polarity) && (!src || r.source === src));

  return (
    <>
      <TopNav />
      <main className="max-w-[1400px] mx-auto px-8 py-8">
        <div className="flex items-end justify-between mb-6">
          <div>
            <h1 className="text-[22px] font-semibold tracking-tight">Feedback</h1>
            <div className="text-sm text-stone-500 mt-1">
              {Object.entries(totalByStatus).map(([s, n]) => `${s.replace("_", " ")}: ${n}`).join(" · ") || "—"}
            </div>
          </div>
          <Link href="/incidents/new" className="bg-brand text-white px-4 py-2 rounded-lg text-sm font-medium hover:bg-brand-hover">
            + Add feedback
          </Link>
        </div>

        {/* Status chips */}
        <div className="flex gap-2 mb-3 text-sm">
          {[
            ["", "All"],
            ["open", "Open"],
            ["closed", "Closed"],
            ["retracted", "Retracted"],
          ].map(([v, label]) => (
            <button
              key={v || "all"}
              onClick={() => setStatus(v)}
              className={`px-3 py-1.5 rounded-lg text-[13px] font-medium ${
                status === v ? "bg-stone-900 text-white" : "bg-white border border-stone-200 text-stone-700 hover:bg-stone-50"
              }`}
            >
              {label}
              {totalByStatus[v] !== undefined && v ? ` (${totalByStatus[v]})` : ""}
            </button>
          ))}
        </div>

        {/* Secondary filters */}
        <div className="flex gap-2 mb-4">
          <select value={severity} onChange={(e) => setSeverity(e.target.value)} className="px-3 py-1.5 border border-stone-200 rounded-lg text-[13px] bg-white">
            <option value="">All severities</option>
            <option value="critical">Critical</option>
            <option value="high">High</option>
            <option value="medium">Medium</option>
            <option value="low">Low</option>
          </select>
          <select value={category} onChange={(e) => setCategory(e.target.value)} className="px-3 py-1.5 border border-stone-200 rounded-lg text-[13px] bg-white">
            <option value="">All categories</option>
            {Object.entries(CATEGORY_LABEL).map(([v, label]) => <option key={v} value={v}>{label}</option>)}
          </select>
          <select value={polarity} onChange={(e) => setPolarity(e.target.value)} className="px-3 py-1.5 border border-stone-200 rounded-lg text-[13px] bg-white">
            <option value="">All polarities</option>
            <option value="positive">Positive</option>
            <option value="negative">Negative</option>
          </select>
          <select value={src} onChange={(e) => setSrc(e.target.value)} className="px-3 py-1.5 border border-stone-200 rounded-lg text-[13px] bg-white">
            <option value="">All sources</option>
            <option value="patient">Patient</option>
            <option value="peer">Peer</option>
            <option value="governance">Governance</option>
          </select>
        </div>

        {/* List */}
        <div className="bg-white border border-stone-200 rounded-xl overflow-hidden">
          {loading ? (
            <div className="py-12 text-center text-sm text-stone-500">Loading…</div>
          ) : visible.length === 0 ? (
            <div className="py-16 text-center text-sm text-stone-500">
              No feedback matches these filters.
            </div>
          ) : (
            <div className="divide-y divide-stone-100">
              {visible.map((r) => (
                <Link
                  key={r.id}
                  href={`/incidents/${r.id}`}
                  className={`block px-5 py-4 hover:bg-stone-50 ${r.status === "retracted" ? "opacity-70" : ""}`}
                >
                  <div className="flex items-start gap-1.5 flex-wrap">
                    <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-[11px] font-medium ${r.polarity === "positive" ? "bg-emerald-50 text-emerald-700" : "bg-stone-800 text-white"}`}>
                      {r.polarity === "positive" ? "Positive" : "Negative"}
                    </span>
                    <span className="inline-flex items-center px-2 py-0.5 rounded-full text-[11px] font-medium bg-violet-50 text-violet-700">
                      {r.source === "patient" ? "Patient" : r.source === "governance" ? "Governance" : "Peer"}
                    </span>
                    {r.polarity === "positive"
                      ? (r.commendation_category ? <span className="inline-flex items-center px-2 py-0.5 rounded-full text-[11px] font-medium bg-emerald-50 text-emerald-700">{r.commendation_category}</span> : null)
                      : <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-[11px] font-medium ${SEV_PILL[r.severity ?? ""] ?? "bg-stone-100 text-stone-700"}`}>{r.severity ?? "\u2014"}</span>}
                    <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-[11px] font-medium ${STATUS_PILL[r.status] ?? "bg-stone-100 text-stone-700"}`}>
                      {r.status}
                    </span>
                    {r.polarity !== "positive" && (
                      <span className="text-[11px] text-stone-500 px-2 py-0.5 rounded-full bg-stone-50">
                        {CATEGORY_LABEL[r.category ?? ""] ?? r.category}
                      </span>
                    )}
                    {r.patient_rating != null && <span className="text-[11px] text-amber-700 px-2 py-0.5 rounded-full bg-amber-50">{"\u2605"} {r.patient_rating}/5</span>}
                    <div className="w-full mt-1.5">
                      <div className={`text-sm font-medium ${r.status === "retracted" ? "line-through text-stone-500" : "text-stone-900"}`}>
                        {r.target_physician_name}
                        {r.hospital_code && <span className="font-normal text-stone-500"> · {r.hospital_code}</span>}
                      </div>
                      <div className="text-xs text-stone-500 mt-0.5 truncate">{r.narrative_preview}</div>
                      <div className="text-[11px] text-stone-400 mt-1">
                        {timeAgo(r.submitted_at)} · {r.anonymous_flag ? "Anonymous" : "Identified"}
                        {!r.anonymous_flag && r.submitter_label ? ` · ${r.submitter_label}` : ""}
                        {r.reply_count > 0 ? ` · ${r.reply_count} ${r.reply_count === 1 ? "reply" : "replies"}` : ""}
                        {r.status === "retracted" && r.retraction_reason ? ` · retracted: ${r.retraction_reason}` : ""}
                      </div>
                    </div>
                  </div>
                </Link>
              ))}
            </div>
          )}
        </div>
      </main>
    </>
  );
}
