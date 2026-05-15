"use client";

import { useEffect, useState } from "react";
import { useParams } from "next/navigation";
import Link from "next/link";
import { TopNav } from "@/components/TopNav";
import { AddObservationModal } from "@/components/AddObservationModal";

interface ObservationCase {
  id: string;
  case_number: number;
  case_date: string;
  procedure: string;
  observer_role: string;
  observer_name: string;
  observer_email: string;
  scores: Record<string, number>;
  narrative_notes: string | null;
  flag_severity: string;
  created_at: string;
}

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
  const [cases, setCases] = useState<ObservationCase[]>([]);
  const [allowedRoles, setAllowedRoles] = useState<string[]>([]);
  const [addOpen, setAddOpen] = useState(false);

  function load() {
    if (!id) return;
    setLoading(true);
    Promise.all([
      fetch(`/api/vc-onboarding/prescreens/${id}`).then((r) => r.json()),
      fetch(`/api/vc-onboarding/prescreens/${id}/observations`).then((r) => r.json()),
    ])
      .then(([pj, oj]) => {
        if (!pj.ok) { setError(pj.error || "Not found"); return; }
        setData(pj.prescreen as Prescreen);
        if (oj.ok) {
          setCases((oj.rows ?? []) as ObservationCase[]);
          setAllowedRoles(oj.allowed_roles ?? []);
        }
      })
      .finally(() => setLoading(false));
  }
  useEffect(() => { load(); /* eslint-disable-next-line */ }, [id]);

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

        {(data.stage === "observation" || data.stage === "decision" || data.stage === "onboarded" || data.stage === "terminated") && (
          <section className="bg-white border border-stone-200 rounded-xl">
            <div className="px-5 py-3.5 border-b border-stone-100 flex items-center justify-between">
              <h2 className="text-sm font-semibold">
                Observation cases <span className="text-[11px] bg-stone-100 text-stone-600 rounded-full px-2 py-0.5 font-medium ml-1">{cases.length}/3+</span>
              </h2>
              {cases.length < 5 && data.stage !== "terminated" && data.stage !== "onboarded" && (
                <button onClick={() => setAddOpen(true)} className="text-[12px] text-brand font-medium">+ Add observation case</button>
              )}
            </div>
            {cases.length === 0 ? (
              <div className="px-5 py-12 text-center text-sm text-stone-500">
                No observation cases yet. <button onClick={() => setAddOpen(true)} className="text-brand font-medium">Add the first →</button>
              </div>
            ) : (
              <div className="divide-y divide-stone-100">
                {cases.map((c) => {
                  const avg = Object.values(c.scores).reduce((a: number, b: number) => a + b, 0) / Math.max(1, Object.keys(c.scores).length);
                  const flagPill =
                    c.flag_severity === "immediate_termination_recommended" ? "bg-red-50 text-red-700" :
                    c.flag_severity === "concern" ? "bg-amber-50 text-amber-800" :
                    "bg-emerald-50 text-emerald-700";
                  const flagLabel =
                    c.flag_severity === "immediate_termination_recommended" ? "Immediate termination" :
                    c.flag_severity === "concern" ? "Concern" : "No concern";
                  return (
                    <div key={c.id} className="px-5 py-4">
                      <div className="flex items-start gap-3 mb-2">
                        <span className="inline-flex items-center px-2 py-0.5 rounded-full text-[11px] font-medium bg-stone-100 text-stone-700">
                          Case {c.case_number}
                        </span>
                        <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-[11px] font-medium ${flagPill}`}>
                          {flagLabel}
                        </span>
                        <span className="text-[11px] text-stone-500 px-2 py-0.5 rounded-full bg-stone-50">{c.case_date.slice(0, 10)}</span>
                        <div className="flex-1 min-w-0">
                          <div className="text-sm font-medium text-stone-900">{c.procedure}</div>
                          <div className="text-xs text-stone-500 mt-0.5">{c.observer_role} · {c.observer_name}</div>
                        </div>
                        <div className="text-right">
                          <div className="text-[11px] text-stone-500 uppercase tracking-wider">avg</div>
                          <div className="text-sm font-semibold num">{avg.toFixed(2)}</div>
                        </div>
                      </div>
                      <div className="grid grid-cols-6 gap-1.5 mt-2">
                        {["teamwork","emr_documentation","ot_etiquette","protocol_adherence","outcome","demeanor"].map((dim) => (
                          <div key={dim} className="text-center bg-stone-50 rounded p-1.5">
                            <div className="text-[10px] text-stone-500">{dim.split("_")[0].slice(0, 7)}</div>
                            <div className="text-sm font-semibold num">{c.scores[dim] ?? "—"}</div>
                          </div>
                        ))}
                      </div>
                      {c.narrative_notes && (
                        <div className="mt-2.5 text-xs text-stone-700 bg-stone-50 rounded px-3 py-2 whitespace-pre-wrap">{c.narrative_notes}</div>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
            {data.stage === "decision" && cases.length >= 3 && (
              <div className="px-5 py-3 border-t border-stone-100 bg-amber-50/30 text-xs text-amber-800">
                ⏳ Decision stage — super-admin can confirm / extend / terminate (ships in EPI.3c).
              </div>
            )}
          </section>
        )}
      </main>

      {addOpen && (
        <AddObservationModal
          prescreenId={id!}
          allowedRoles={allowedRoles}
          onClose={() => setAddOpen(false)}
          onSaved={() => { setAddOpen(false); load(); }}
        />
      )}
    </>
  );
}
