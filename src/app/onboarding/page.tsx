"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { TopNav } from "@/components/TopNav";

interface Row {
  id: string;
  prospective_email: string;
  prospective_full_name: string;
  prospective_specialty: string | null;
  hospital_code: string;
  decision: string;
  decision_rationale: string | null;
  stage: string;
  cooldown_override: boolean;
  prescreened_by_email: string;
  prescreened_at: string;
  decided_at: string | null;
  physician_id: string | null;
  years_post_postgraduate: number | null;
  red_flags: string | null;
}

const STAGE_LABEL: Record<string, { label: string; pill: string }> = {
  prescreen:    { label: "Pre-screen",    pill: "bg-stone-100 text-stone-700" },
  observation:  { label: "Observation",   pill: "bg-amber-50 text-amber-800" },
  decision:     { label: "Decision",      pill: "bg-blue-50 text-blue-800" },
  onboarded:    { label: "Onboarded",     pill: "bg-emerald-50 text-emerald-700" },
  rejected:     { label: "Rejected",      pill: "bg-stone-100 text-stone-600" },
  terminated:   { label: "Terminated",    pill: "bg-red-50 text-red-700" },
};

function timeAgo(iso: string): string {
  const t = new Date(iso).getTime();
  const s = Math.max(1, Math.floor((Date.now() - t) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

export default function OnboardingPage() {
  const [rows, setRows] = useState<Row[]>([]);
  const [counts, setCounts] = useState<Record<string, number>>({});
  const [filter, setFilter] = useState<string>("");
  const [loading, setLoading] = useState(true);

  function load() {
    setLoading(true);
    const u = new URL("/api/vc-onboarding/prescreens", window.location.origin);
    if (filter) u.searchParams.set("stage", filter);
    fetch(u.toString())
      .then((r) => r.json())
      .then((j) => {
        if (j.ok) {
          setRows(j.rows ?? []);
          setCounts(j.counts ?? {});
        }
      })
      .finally(() => setLoading(false));
  }
  useEffect(() => { load(); /* eslint-disable-next-line */ }, [filter]);

  return (
    <>
      <TopNav />
      <main className="max-w-[1400px] mx-auto px-8 py-8">
        <div className="flex items-end justify-between mb-6">
          <div>
            <h1 className="text-[22px] font-semibold tracking-tight">VC onboarding</h1>
            <div className="text-sm text-stone-500 mt-1">
              {Object.entries(counts).map(([k, n]) => `${STAGE_LABEL[k]?.label ?? k}: ${n}`).join(" · ") || "—"}
            </div>
          </div>
          <Link href="/onboarding/new" className="bg-brand text-white px-4 py-2 rounded-lg text-sm font-medium hover:bg-brand-hover">
            + New VC invitation
          </Link>
        </div>

        {/* Stage chips */}
        <div className="flex flex-wrap gap-2 mb-4 text-sm">
          {[
            ["", "All"],
            ["prescreen", "Pre-screen"],
            ["observation", "Observation"],
            ["decision", "Decision"],
            ["onboarded", "Onboarded"],
            ["rejected", "Rejected"],
            ["terminated", "Terminated"],
          ].map(([v, label]) => (
            <button
              key={v || "all"}
              onClick={() => setFilter(v)}
              className={`px-3 py-1.5 rounded-lg text-[13px] font-medium ${
                filter === v ? "bg-stone-900 text-white" : "bg-white border border-stone-200 text-stone-700 hover:bg-stone-50"
              }`}
            >
              {label}{v && counts[v] !== undefined ? ` (${counts[v]})` : ""}
            </button>
          ))}
        </div>

        <div className="bg-white border border-stone-200 rounded-xl overflow-hidden">
          {loading ? (
            <div className="py-12 text-center text-sm text-stone-500">Loading…</div>
          ) : rows.length === 0 ? (
            <div className="py-16 text-center text-sm text-stone-500">
              No VC pipeline entries. <Link href="/onboarding/new" className="text-brand font-medium">Start one →</Link>
            </div>
          ) : (
            <div className="divide-y divide-stone-100">
              {rows.map((r) => {
                const stage = STAGE_LABEL[r.stage] ?? { label: r.stage, pill: "bg-stone-100 text-stone-700" };
                return (
                  <Link
                    key={r.id}
                    href={`/onboarding/${r.id}`}
                    className="block px-5 py-4 hover:bg-stone-50"
                  >
                    <div className="flex items-start gap-3">
                      <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-[11px] font-medium ${stage.pill}`}>
                        {stage.label}
                      </span>
                      <span className="text-[11px] text-stone-500 px-2 py-0.5 rounded-full bg-stone-50">
                        {r.hospital_code}
                      </span>
                      <div className="flex-1 min-w-0">
                        <div className="text-sm font-medium text-stone-900">
                          {r.prospective_full_name}
                          {r.prospective_specialty && <span className="font-normal text-stone-500"> · {r.prospective_specialty}</span>}
                        </div>
                        <div className="text-xs text-stone-500 mt-0.5">
                          {r.prospective_email}
                          {r.years_post_postgraduate ? ` · ${r.years_post_postgraduate}y post-PG` : ""}
                        </div>
                        <div className="text-[11px] text-stone-400 mt-1">
                          Pre-screened {timeAgo(r.prescreened_at)} by {r.prescreened_by_email}
                          {r.red_flags ? ` · ⚠ ${r.red_flags.slice(0, 60)}${r.red_flags.length > 60 ? "…" : ""}` : ""}
                          {r.cooldown_override ? " · cooldown overridden" : ""}
                        </div>
                      </div>
                    </div>
                  </Link>
                );
              })}
            </div>
          )}
        </div>
      </main>
    </>
  );
}
