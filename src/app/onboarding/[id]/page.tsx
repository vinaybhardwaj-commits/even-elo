"use client";

import { useEffect, useState } from "react";
import { useParams } from "next/navigation";
import Link from "next/link";
import { TopNav } from "@/components/TopNav";

interface Prescreen {
  id: string;
  prospective_email: string;
  prospective_full_name: string;
  prospective_specialty: string | null;
  hospital_code: string;
  hospital_name: string;
  years_post_postgraduate: number | null;
  prior_corporate_hospitals: string[] | null;
  commitments_acknowledged: Record<string, boolean> | null;
  red_flags: string | null;
  decision: string;
  decision_rationale: string | null;
  cooldown_override: boolean;
  stage: string;
  prescreened_by_email: string;
  prescreened_at: string;
  decided_at: string | null;
}

const COMMITMENT_LABEL: Record<string, string> = {
  ot_timings: "OT timings",
  formulary: "Formulary discipline",
  vendor_mou: "Vendor MOU respect",
  rental_equipment: "Rental equipment policy",
  weekend_protocol: "Weekend/holiday protocol",
};

const STAGE_LABEL: Record<string, { label: string; pill: string }> = {
  prescreen:    { label: "Pre-screen",    pill: "bg-stone-100 text-stone-700" },
  observation:  { label: "Observation",   pill: "bg-amber-50 text-amber-800" },
  decision:     { label: "Decision",      pill: "bg-blue-50 text-blue-800" },
  onboarded:    { label: "Onboarded",     pill: "bg-emerald-50 text-emerald-700" },
  rejected:     { label: "Rejected",      pill: "bg-stone-100 text-stone-600" },
  terminated:   { label: "Terminated",    pill: "bg-red-50 text-red-700" },
};

export default function OnboardingDetailPage() {
  const params = useParams<{ id: string }>();
  const id = params?.id;
  const [data, setData] = useState<Prescreen | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!id) return;
    fetch(`/api/vc-onboarding/prescreens/${id}`)
      .then((r) => r.json())
      .then((j) => {
        if (!j.ok) { setError(j.error || "Not found"); return; }
        setData(j.prescreen as Prescreen);
      })
      .finally(() => setLoading(false));
  }, [id]);

  if (loading) return (<><TopNav /><main className="max-w-[900px] mx-auto px-8 py-8 text-sm text-stone-500">Loading…</main></>);
  if (error || !data) return (
    <>
      <TopNav />
      <main className="max-w-[900px] mx-auto px-8 py-12 text-center">
        <h1 className="text-lg font-semibold mb-2">{error || "Not found"}</h1>
        <Link href="/onboarding" className="text-brand text-sm font-medium">← Back</Link>
      </main>
    </>
  );

  const stage = STAGE_LABEL[data.stage] ?? { label: data.stage, pill: "bg-stone-100 text-stone-700" };
  const commitments = data.commitments_acknowledged ?? {};

  return (
    <>
      <TopNav />
      <main className="max-w-[900px] mx-auto px-8 py-8 space-y-4">
        <div className="text-sm text-stone-500">
          <Link href="/onboarding" className="hover:text-stone-900">Onboarding</Link>
          <span className="mx-1.5">/</span>
          <span className="text-stone-900 font-medium">{data.prospective_full_name}</span>
        </div>

        <section className="bg-white border border-stone-200 rounded-xl p-5">
          <div className="flex items-start gap-3 mb-2">
            <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-[11px] font-medium ${stage.pill}`}>{stage.label}</span>
            <span className="text-[11px] text-stone-500 px-2 py-0.5 rounded-full bg-stone-50">{data.hospital_code}</span>
            {data.decision === "reject" && (
              <span className="inline-flex items-center px-2 py-0.5 rounded-full text-[11px] font-medium bg-red-50 text-red-700">
                Rejected{data.cooldown_override ? " · override" : " · 12mo cooldown"}
              </span>
            )}
          </div>
          <h1 className="text-xl font-semibold tracking-tight">{data.prospective_full_name}</h1>
          <div className="text-sm text-stone-500 mt-1">
            {data.prospective_email}
            {data.prospective_specialty ? ` · ${data.prospective_specialty}` : ""}
            {data.years_post_postgraduate ? ` · ${data.years_post_postgraduate}y post-PG` : ""}
          </div>
          <div className="text-xs text-stone-500 mt-3">
            Pre-screened by {data.prescreened_by_email} · {new Date(data.prescreened_at).toLocaleString("en-IN", { dateStyle: "medium", timeStyle: "short" })}
          </div>
          {data.decision_rationale && (
            <div className="mt-3 px-3 py-2 bg-stone-50 rounded-lg text-sm">
              <strong className="text-stone-700">Rationale:</strong> {data.decision_rationale}
            </div>
          )}
        </section>

        <div className="grid grid-cols-2 gap-4">
          <section className="bg-white border border-stone-200 rounded-xl p-5">
            <h2 className="text-sm font-semibold mb-2">Commitments</h2>
            <ul className="text-xs space-y-1.5">
              {Object.entries(COMMITMENT_LABEL).map(([k, label]) => (
                <li key={k} className="flex items-center gap-2">
                  <span className={commitments[k] ? "text-emerald-700" : "text-stone-400"}>{commitments[k] ? "✓" : "○"}</span>
                  <span className={commitments[k] ? "text-stone-700" : "text-stone-400"}>{label}</span>
                </li>
              ))}
            </ul>
          </section>

          <section className="bg-white border border-stone-200 rounded-xl p-5">
            <h2 className="text-sm font-semibold mb-2">Prior corporate hospitals</h2>
            {data.prior_corporate_hospitals && data.prior_corporate_hospitals.length > 0 ? (
              <ul className="text-xs text-stone-700 space-y-1 list-disc pl-4">
                {data.prior_corporate_hospitals.map((p, i) => <li key={i}>{p}</li>)}
              </ul>
            ) : (
              <div className="text-xs text-stone-400">None recorded</div>
            )}
            {data.red_flags && (
              <div className="mt-3 pt-3 border-t border-stone-100">
                <div className="text-[11px] font-medium text-stone-500 tracking-wider uppercase mb-1">Red flags</div>
                <div className="text-xs text-stone-700 whitespace-pre-wrap">{data.red_flags}</div>
              </div>
            )}
          </section>
        </div>

        {data.stage === "observation" && (
          <section className="bg-white border border-stone-200 rounded-xl p-5 text-center text-sm text-stone-500">
            Observation cases (3 minimum, max 5) ship in <strong>EPI.3b</strong>.
          </section>
        )}
        {data.stage === "decision" && (
          <section className="bg-white border border-stone-200 rounded-xl p-5 text-center text-sm text-stone-500">
            Final decision UI (confirm / extend / terminate) ships in <strong>EPI.3c</strong>.
          </section>
        )}
      </main>
    </>
  );
}
