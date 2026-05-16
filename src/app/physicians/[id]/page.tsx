"use client";

import { useEffect, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import Link from "next/link";
import { TopNav } from "@/components/TopNav";
import { AddEngagementModal } from "@/components/AddEngagementModal";
import { AddQualificationModal } from "@/components/AddQualificationModal";
import { AddPrivilegeModal } from "@/components/AddPrivilegeModal";
import { MiniLineChart } from "@/components/MiniLineChart";

interface Physician {
  id: string;
  full_name: string;
  preferred_name: string | null;
  primary_specialty: string | null;
  registration_number: string | null;
  registration_council: string | null;
  registration_expiry: string | null;
  email: string | null;
  phone: string | null;
  date_joined_network: string | null;
  current_status: string;
  notes: string | null;
}

interface Engagement {
  id: string;
  hospital_code: string;
  hospital_name: string;
  engagement_type: string;
  start_date: string;
  end_date: string | null;
  specialty: string | null;
  status: string;
  terminated_reason: string | null;
}

interface Qualification {
  id: string;
  degree: string;
  institution: string | null;
  institution_tier: string | null;
  year_completed: number | null;
  country: string | null;
  verified: boolean;
  verified_at: string | null;
  verified_by_email: string | null;
  has_file: boolean;
  file_filename: string | null;
  file_mime: string | null;
  file_size_bytes: number | null;
  created_at: string;
}

interface Privilege {
  id: string;
  hospital_code: string;
  hospital_name: string;
  procedure_or_specialty: string;
  granted_date: string;
  basis: string;
  granted_by_email: string | null;
  withdrawn_date: string | null;
  withdrawn_reason: string | null;
}

interface FeedbackRow {
  id: string;
  hospital_code: string;
  feedback_period: string;
  csat_score: number | null;
  complaint_count: number | null;
  source: string | null;
  uploaded_at: string;
  uploaded_by_email: string | null;
}

interface IncidentRow {
  id: string;
  submitted_at: string;
  anonymous_flag: boolean;
  submitter_label: string;
  category: string;
  severity: string;
  narrative_preview: string;
  status: string;
  retracted_at: string | null;
  retraction_reason: string | null;
  reply_count: number;
}

interface MetricsRow {
  hospital_code: string;
  year: number;
  month: number;
  opd_count: number | null;
  ipd_admissions: number | null;
  ot_cases: number | null;
  revenue_inr: number | null;
  uploaded_at: string;
  uploaded_by_email: string | null;
}

interface UserSummary {
  is_super_admin: boolean;
  is_hr: boolean;
  is_site_medical_head: boolean;
}

interface AuditRow {
  id: number;
  action: string;
  entity_type: string;
  entity_id: string | null;
  created_at: string;
  actor_email: string | null;
  actor_position: string | null;
}

const AVATAR_COLORS = [
  "bg-teal-100 text-teal-800", "bg-orange-100 text-orange-800", "bg-violet-100 text-violet-800",
  "bg-rose-100 text-rose-800", "bg-lime-100 text-lime-800", "bg-sky-100 text-sky-800",
];
function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}
function colorFor(name: string): string {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) & 0xffff;
  return AVATAR_COLORS[h % AVATAR_COLORS.length];
}

const STATUS_PILL: Record<string, string> = {
  active: "bg-emerald-50 text-emerald-700",
  inactive: "bg-stone-100 text-stone-600",
  terminated: "bg-red-50 text-red-700",
};

const ENGAGEMENT_TYPE_LABEL: Record<string, string> = {
  employed: "Employed",
  part_time: "Part-time",
  visiting_consultant: "VC",
};

const SECTIONS = [
  { key: "overview", label: "Overview", available: true },
  { key: "engagements", label: "Engagements", available: true },
  { key: "qualifications", label: "Qualifications & privileges", available: true },
  { key: "metrics", label: "Clinical metrics", available: true },
  { key: "elo", label: "Surgical score · Even ELO", available: false, sprint: "Phase 3" },
  { key: "incidents", label: "Incidents", available: true },
  { key: "feedback", label: "Patient feedback", available: true },
] as const;

function timeAgo(iso: string): string {
  const t = new Date(iso).getTime();
  const s = Math.max(1, Math.floor((Date.now() - t) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

function fmtDate(iso: string | null): string {
  if (!iso) return "—";
  return iso.slice(0, 10);
}

export default function PhysicianProfilePage() {
  const params = useParams<{ id: string }>();
  const router = useRouter();
  const id = params?.id;

  const [physician, setPhysician] = useState<Physician | null>(null);
  const [engagements, setEngagements] = useState<Engagement[]>([]);
  const [audit, setAudit] = useState<AuditRow[]>([]);
  const [quals, setQuals] = useState<Qualification[]>([]);
  const [privs, setPrivs] = useState<Privilege[]>([]);
  const [me, setMe] = useState<UserSummary | null>(null);
  const [metrics, setMetrics] = useState<MetricsRow[]>([]);
  const [incidentsList, setIncidentsList] = useState<IncidentRow[]>([]);
  const [feedback, setFeedback] = useState<FeedbackRow[]>([]);
  const [addQual, setAddQual] = useState(false);
  const [addPriv, setAddPriv] = useState(false);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [section, setSection] = useState<string>("overview");
  const [addEng, setAddEng] = useState(false);

  function load() {
    if (!id) return;
    setLoading(true);
    Promise.all([
      fetch(`/api/physicians/${id}`).then((r) => r.json()),
      fetch(`/api/physicians/${id}/audit?limit=20`).then((r) => r.json()),
      fetch(`/api/physicians/${id}/qualifications`).then((r) => r.json()),
      fetch(`/api/physicians/${id}/privileges`).then((r) => r.json()),
      fetch(`/api/auth/me`).then((r) => r.json()),
      fetch(`/api/physicians/${id}/clinical-metrics?months=24`).then((r) => r.json()),
      fetch(`/api/incidents?physician_id=${id}&limit=100`).then((r) => r.json()),
      fetch(`/api/physicians/${id}/patient-feedback`).then((r) => r.json()),
    ])
      .then(([pj, aj, qj, prj, mj, mxj, inj, fj]) => {
        if (!pj.ok) { setErr(pj.error || "Not found"); return; }
        setPhysician(pj.physician as Physician);
        setEngagements((pj.engagements ?? []) as Engagement[]);
        if (aj.ok) setAudit(aj.rows ?? []);
        if (qj.ok) setQuals(qj.rows ?? []);
        if (prj.ok) setPrivs(prj.rows ?? []);
        if (mj.ok) setMe(mj.user as UserSummary);
        if (mxj.ok) setMetrics(mxj.rows ?? []);
        if (inj.ok) setIncidentsList(inj.rows ?? []);
        if (fj.ok) setFeedback(fj.rows ?? []);
      })
      .catch((e) => setErr(e instanceof Error ? e.message : String(e)))
      .finally(() => setLoading(false));
  }

  useEffect(() => { load(); /* eslint-disable-next-line */ }, [id]);

  async function endEngagement(eid: string) {
    const reason = prompt("Reason for ending this engagement?");
    if (reason === null) return;
    await fetch(`/api/physicians/${id}/engagements/${eid}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        status: "terminated",
        end_date: new Date().toISOString().slice(0, 10),
        terminated_reason: reason || null,
      }),
    });
    load();
  }


  async function verifyQual(qid: string) {
    await fetch(`/api/physicians/${id}/qualifications/${qid}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ verified: true }),
    });
    load();
  }

  async function deleteQual(qid: string) {
    if (!confirm("Delete this qualification? This cannot be undone.")) return;
    await fetch(`/api/physicians/${id}/qualifications/${qid}`, { method: "DELETE" });
    load();
  }

  async function withdrawPrivilege(prid: string) {
    const reason = prompt("Reason for withdrawing this privilege?");
    if (reason === null) return;
    await fetch(`/api/physicians/${id}/privileges/${prid}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        withdrawn_date: new Date().toISOString().slice(0, 10),
        withdrawn_reason: reason || null,
      }),
    });
    load();
  }

  async function deletePhysician() {
    if (!confirm(`Mark ${physician?.full_name} as terminated? They can be reactivated later.`)) return;
    await fetch(`/api/physicians/${id}`, { method: "DELETE" });
    router.push("/physicians");
  }

  if (loading) {
    return (
      <>
        <TopNav />
        <main className="max-w-[1400px] mx-auto px-8 py-8 text-sm text-stone-500">Loading…</main>
      </>
    );
  }
  if (err || !physician) {
    return (
      <>
        <TopNav />
        <main className="max-w-[1400px] mx-auto px-8 py-12 text-center">
          <h1 className="text-lg font-semibold mb-2">{err || "Physician not found"}</h1>
          <Link href="/physicians" className="text-brand text-sm font-medium">← Back to roster</Link>
        </main>
      </>
    );
  }

  const activeEng = engagements.filter((e) => e.status === "active");
  const sortedEng = [...engagements].sort((a, b) => (a.start_date < b.start_date ? 1 : -1));

  return (
    <>
      <TopNav />

      {/* Identity header */}
      <div className="bg-white border-b border-stone-200">
        <div className="max-w-[1400px] mx-auto px-8 py-6">
          <div className="text-sm text-stone-500 mb-2">
            <Link href="/physicians" className="hover:text-stone-900">Physicians</Link>
            <span className="mx-1.5">/</span>
            <span className="text-stone-900 font-medium">{physician.full_name}</span>
          </div>
          <div className="flex items-start gap-6">
            <span className={`w-[72px] h-[72px] rounded-full inline-flex items-center justify-center text-[22px] font-medium ${colorFor(physician.full_name)}`}>
              {initials(physician.full_name)}
            </span>
            <div className="flex-1">
              <div className="flex items-center gap-3 mb-1">
                <h1 className="text-2xl font-semibold tracking-tight">{physician.full_name}</h1>
                <span className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium ${STATUS_PILL[physician.current_status] ?? "bg-stone-100 text-stone-600"}`}>
                  {physician.current_status}
                </span>
                {physician.primary_specialty && (
                  <span className="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium bg-stone-100 text-stone-700">
                    {physician.primary_specialty}
                  </span>
                )}
              </div>
              <div className="text-sm text-stone-500">
                {physician.registration_number ? `${physician.registration_council ?? "Reg"} ${physician.registration_number} · ` : ""}
                {physician.email ?? "no email on file"}
                {physician.phone ? ` · ${physician.phone}` : ""}
              </div>
              <div className="flex gap-6 items-center mt-4">
                <div>
                  <div className="text-[11px] font-medium text-stone-500 tracking-wider uppercase">Active engagements</div>
                  <div className="num text-2xl font-semibold mt-1">{activeEng.length}</div>
                </div>
                <div className="border-l border-stone-200 h-9"></div>
                <div>
                  <div className="text-[11px] font-medium text-stone-500 tracking-wider uppercase">Joined network</div>
                  <div className="text-sm font-medium mt-1.5">{fmtDate(physician.date_joined_network)}</div>
                </div>
                <div className="border-l border-stone-200 h-9"></div>
                <div>
                  <div className="text-[11px] font-medium text-stone-500 tracking-wider uppercase">License expires</div>
                  <div className="text-sm font-medium mt-1.5">{fmtDate(physician.registration_expiry)}</div>
                </div>
                <div className="border-l border-stone-200 h-9"></div>
                <div>
                  <div className="text-[11px] font-medium text-stone-500 tracking-wider uppercase">ELO composite</div>
                  <div className="text-sm font-medium mt-1.5 text-stone-400">— · Phase 3</div>
                </div>
              </div>
            </div>
            <div className="flex gap-2">
              <button onClick={deletePhysician} className="px-3 py-2 rounded-lg text-sm font-medium text-red-700 bg-red-50 hover:bg-red-100">
                Mark terminated
              </button>
            </div>
          </div>
        </div>
      </div>

      {/* Body: sidebar + main pane */}
      <main className="max-w-[1400px] mx-auto px-8 py-6 grid grid-cols-[220px_1fr] gap-6">
        <aside>
          {SECTIONS.map((s) => (
            <button
              key={s.key}
              onClick={() => s.available && setSection(s.key)}
              disabled={!s.available}
              className={`w-full text-left flex items-center gap-2 px-3 py-2 rounded-lg text-[13px] font-medium transition ${
                section === s.key
                  ? "bg-brand-softer text-brand"
                  : s.available
                  ? "text-stone-600 hover:bg-stone-100 hover:text-stone-900"
                  : "text-stone-300 cursor-not-allowed"
              }`}
            >
              <span>{s.label}</span>
              {!s.available && (
                <span className="ml-auto text-[10px] text-stone-300">{s.sprint}</span>
              )}
            </button>
          ))}
        </aside>

        <div>
          {section === "overview" && (
            <div className="space-y-4">
              <section className="bg-white border border-stone-200 rounded-xl p-5">
                <h2 className="text-sm font-semibold mb-4">Snapshot</h2>
                <div className="grid grid-cols-3 gap-4">
                  <div className="bg-stone-50 rounded-lg p-3">
                    <div className="text-[11px] font-medium text-stone-500 tracking-wider uppercase">Engagements</div>
                    <div className="num text-xl font-semibold mt-1">{engagements.length}</div>
                    <div className="text-[11px] text-stone-500 mt-0.5">{activeEng.length} active</div>
                  </div>
                  <div className="bg-stone-50 rounded-lg p-3">
                    <div className="text-[11px] font-medium text-stone-500 tracking-wider uppercase">Open incidents</div>
                    <div className={`num text-xl font-semibold mt-1 ${incidentsList.filter((r) => r.status === "open").length > 0 ? "text-amber-700" : "text-stone-400"}`}>{incidentsList.filter((r) => r.status === "open").length}</div>
                    <button onClick={() => setSection("incidents")} className="text-[11px] text-brand hover:underline mt-0.5">View →</button>
                  </div>
                  <div className="bg-stone-50 rounded-lg p-3">
                    <div className="text-[11px] font-medium text-stone-500 tracking-wider uppercase">ELO composite</div>
                    <div className="num text-xl font-semibold mt-1 text-stone-400">—</div>
                    <div className="text-[11px] text-stone-400 mt-0.5">Phase 3</div>
                  </div>
                </div>
                {physician.notes && (
                  <div className="mt-4 pt-4 border-t border-stone-100">
                    <div className="text-[11px] font-medium text-stone-500 tracking-wider uppercase mb-2">Notes</div>
                    <div className="text-sm text-stone-700 whitespace-pre-wrap">{physician.notes}</div>
                  </div>
                )}
              </section>

              <section className="bg-white border border-stone-200 rounded-xl">
                <div className="px-5 py-3.5 border-b border-stone-100 flex items-center justify-between">
                  <h2 className="text-sm font-semibold">Recent activity</h2>
                  <span className="text-[11px] bg-stone-100 text-stone-600 rounded-full px-2 py-0.5 font-medium">{audit.length}</span>
                </div>
                {audit.length === 0 ? (
                  <div className="px-5 py-8 text-center text-sm text-stone-500">No activity recorded yet.</div>
                ) : (
                  <div className="px-4 py-2 mono text-[11px] text-stone-700">
                    {audit.map((r) => (
                      <div key={r.id} className="py-1.5 border-b border-dashed border-stone-100 last:border-b-0 leading-relaxed">
                        <div className="text-stone-400 text-[10px]">{timeAgo(r.created_at)}</div>
                        <div>{r.actor_email ?? "—"}{r.actor_position ? ` · ${r.actor_position}` : ""}</div>
                        <div className={
                          r.action === "delete" || r.action === "retract" ? "text-red-700"
                          : r.action === "update" ? "text-blue-700" : "text-emerald-700"
                        }>
                          {r.action} {r.entity_type}
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </section>
            </div>
          )}

          {section === "engagements" && (
            <section className="bg-white border border-stone-200 rounded-xl">
              <div className="px-5 py-3.5 border-b border-stone-100 flex items-center justify-between">
                <h2 className="text-sm font-semibold">Engagements <span className="text-[11px] bg-stone-100 text-stone-600 rounded-full px-2 py-0.5 font-medium ml-1">{engagements.length}</span></h2>
                <button onClick={() => setAddEng(true)} className="text-[12px] text-brand font-medium">+ Add engagement</button>
              </div>
              {engagements.length === 0 ? (
                <div className="px-5 py-12 text-center text-sm text-stone-500">
                  No engagements yet. <button onClick={() => setAddEng(true)} className="text-brand font-medium">Add the first one →</button>
                </div>
              ) : (
                <div className="divide-y divide-stone-100">
                  {sortedEng.map((e) => (
                    <div key={e.id} className="px-5 py-4 flex items-start gap-4">
                      <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-[11px] font-medium ${
                        e.status === "active" ? "bg-emerald-50 text-emerald-700" : "bg-stone-100 text-stone-500"
                      }`}>
                        {ENGAGEMENT_TYPE_LABEL[e.engagement_type] ?? e.engagement_type} · {e.status}
                      </span>
                      <div className="flex-1">
                        <div className="text-sm font-medium text-stone-900">{e.hospital_code} · {e.specialty ?? physician.primary_specialty ?? "—"}</div>
                        <div className="text-xs text-stone-500 mt-0.5">
                          {fmtDate(e.start_date)} → {e.end_date ? fmtDate(e.end_date) : "present"}
                          {e.terminated_reason && <span className="text-red-700"> · {e.terminated_reason}</span>}
                        </div>
                      </div>
                      {e.status === "active" && (
                        <button onClick={() => endEngagement(e.id)} className="text-[12px] text-stone-500 hover:text-red-700">
                          End engagement
                        </button>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </section>
          )}


          {section === "qualifications" && (
            <div className="space-y-4">
              <section className="bg-white border border-stone-200 rounded-xl">
                <div className="px-5 py-3.5 border-b border-stone-100 flex items-center justify-between">
                  <h2 className="text-sm font-semibold">Qualifications <span className="text-[11px] bg-stone-100 text-stone-600 rounded-full px-2 py-0.5 font-medium ml-1">{quals.length}</span></h2>
                  <button onClick={() => setAddQual(true)} className="text-[12px] text-brand font-medium">+ Add qualification</button>
                </div>
                {quals.length === 0 ? (
                  <div className="px-5 py-12 text-center text-sm text-stone-500">
                    No qualifications yet. <button onClick={() => setAddQual(true)} className="text-brand font-medium">Add the first one →</button>
                  </div>
                ) : (
                  <div className="divide-y divide-stone-100">
                    {quals.map((q) => (
                      <div key={q.id} className="px-5 py-4 flex items-start gap-4">
                        <div className="flex-1">
                          <div className="text-sm font-medium text-stone-900">{q.degree}</div>
                          <div className="text-xs text-stone-500 mt-0.5">
                            {q.institution ?? "—"}
                            {q.institution_tier && q.institution_tier !== "Unknown" && (
                              <span className="ml-1 text-stone-400">· Tier {q.institution_tier}</span>
                            )}
                            {q.year_completed && <span className="ml-1">· {q.year_completed}</span>}
                            {q.country && <span className="ml-1">· {q.country}</span>}
                          </div>
                          <div className="flex items-center gap-2 mt-2">
                            {q.has_file && (
                              <a
                                href={`/api/physicians/${id}/qualifications/${q.id}/file`}
                                target="_blank"
                                rel="noreferrer"
                                className="inline-flex items-center gap-1.5 text-[12px] text-brand font-medium hover:underline"
                              >
                                View certificate
                                <span className="text-stone-400">· {q.file_filename} ({((q.file_size_bytes ?? 0) / 1024).toFixed(0)} KB)</span>
                              </a>
                            )}
                            {!q.has_file && <span className="text-[12px] text-stone-400">No certificate uploaded</span>}
                          </div>
                        </div>
                        <div className="flex flex-col items-end gap-2">
                          {q.verified ? (
                            <span className="inline-flex items-center px-2 py-0.5 rounded-full text-[11px] font-medium bg-emerald-50 text-emerald-700">
                              ✓ Verified{q.verified_by_email ? ` by ${q.verified_by_email.split("@")[0]}` : ""}
                            </span>
                          ) : (
                            (me?.is_super_admin || me?.is_hr || me?.is_site_medical_head) && (
                              <button
                                onClick={() => verifyQual(q.id)}
                                className="px-3 py-1 rounded-lg text-[12px] font-medium bg-emerald-50 text-emerald-700 hover:bg-emerald-100"
                              >
                                Verify
                              </button>
                            )
                          )}
                          {me?.is_super_admin && (
                            <button onClick={() => deleteQual(q.id)} className="text-[11px] text-stone-400 hover:text-red-700">Delete</button>
                          )}
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </section>

              <section className="bg-white border border-stone-200 rounded-xl">
                <div className="px-5 py-3.5 border-b border-stone-100 flex items-center justify-between">
                  <h2 className="text-sm font-semibold">Privileges <span className="text-[11px] bg-stone-100 text-stone-600 rounded-full px-2 py-0.5 font-medium ml-1">{privs.length}</span></h2>
                  <button onClick={() => setAddPriv(true)} className="text-[12px] text-brand font-medium">+ Grant privilege</button>
                </div>
                {privs.length === 0 ? (
                  <div className="px-5 py-12 text-center text-sm text-stone-500">
                    No privileges yet. <button onClick={() => setAddPriv(true)} className="text-brand font-medium">Grant the first →</button>
                  </div>
                ) : (
                  <div className="divide-y divide-stone-100">
                    {privs.map((pr) => {
                      const withdrawn = !!pr.withdrawn_date;
                      return (
                        <div key={pr.id} className="px-5 py-4 flex items-start gap-4">
                          <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-[11px] font-medium ${
                            withdrawn ? "bg-stone-100 text-stone-500" : "bg-emerald-50 text-emerald-700"
                          }`}>
                            {withdrawn ? "Withdrawn" : "Active"}
                          </span>
                          <div className="flex-1">
                            <div className="text-sm font-medium text-stone-900">{pr.procedure_or_specialty} <span className="font-normal text-stone-500">· {pr.hospital_code}</span></div>
                            <div className="text-xs text-stone-500 mt-0.5">
                              Granted {fmtDate(pr.granted_date)} · {pr.basis.replace(/_/g, " ")}
                              {pr.granted_by_email && <span className="ml-1">· by {pr.granted_by_email.split("@")[0]}</span>}
                            </div>
                            {withdrawn && (
                              <div className="text-xs text-red-700 mt-0.5">Withdrawn {fmtDate(pr.withdrawn_date)}{pr.withdrawn_reason ? ` · ${pr.withdrawn_reason}` : ""}</div>
                            )}
                          </div>
                          {!withdrawn && me?.is_super_admin && (
                            <button onClick={() => withdrawPrivilege(pr.id)} className="text-[12px] text-stone-500 hover:text-red-700">
                              Withdraw
                            </button>
                          )}
                        </div>
                      );
                    })}
                  </div>
                )}
              </section>
            </div>
          )}


          {section === "metrics" && (
            <div className="space-y-4">
              {metrics.length === 0 ? (
                <section className="bg-white border border-stone-200 rounded-xl py-12 text-center">
                  <div className="text-sm text-stone-700 font-medium">No clinical metrics yet</div>
                  <div className="text-xs text-stone-500 mt-1">Super-admin uploads monthly CSVs from <Link href="/admin/metrics" className="text-brand font-medium">/admin/metrics</Link>.</div>
                </section>
              ) : (
                (() => {
                  const byHospital = new Map<string, MetricsRow[]>();
                  for (const m of metrics) {
                    const list = byHospital.get(m.hospital_code) ?? [];
                    list.push(m);
                    byHospital.set(m.hospital_code, list);
                  }
                  return Array.from(byHospital.entries()).map(([code, list]) => {
                    const sorted = [...list].sort((a, b) => (a.year * 12 + a.month) - (b.year * 12 + b.month));
                    const labels = sorted.map((m) => `${String(m.month).padStart(2, "0")}/${String(m.year).slice(2)}`);
                    const series = (key: keyof MetricsRow) =>
                      sorted.map((m, i) => ({ x: i, y: (m[key] as number | null) ?? null, label: labels[i] }));
                    const fmt = (n: number | null) => n === null || n === undefined ? "—" : Number(n).toLocaleString("en-IN");
                    return (
                      <section key={code} className="bg-white border border-stone-200 rounded-xl">
                        <div className="px-5 py-3.5 border-b border-stone-100 flex items-center justify-between">
                          <h2 className="text-sm font-semibold">{code} <span className="text-[11px] text-stone-500 font-normal">· last {sorted.length} months</span></h2>
                        </div>
                        <div className="grid grid-cols-2 gap-3 px-5 py-4">
                          {[
                            { key: "opd_count" as const, label: "OPD visits", color: "#0f766e" },
                            { key: "ipd_admissions" as const, label: "IPD admissions", color: "#2563eb" },
                            { key: "ot_cases" as const, label: "OT cases", color: "#d97706" },
                            { key: "revenue_inr" as const, label: "Revenue (INR)", color: "#16a34a" },
                          ].map((m) => {
                            const last = sorted[sorted.length - 1];
                            const lastVal = last ? (last[m.key] as number | null) : null;
                            return (
                              <div key={m.key} className="bg-stone-50 rounded-lg p-3">
                                <div className="flex items-baseline justify-between mb-1.5">
                                  <div className="text-[11px] font-medium text-stone-500 tracking-wider uppercase">{m.label}</div>
                                  <div className="text-sm font-semibold num">{fmt(lastVal)}</div>
                                </div>
                                <MiniLineChart points={series(m.key)} color={m.color} />
                              </div>
                            );
                          })}
                        </div>
                        <div className="border-t border-stone-100 px-5 py-3 max-h-[260px] overflow-y-auto">
                          <table className="w-full text-xs">
                            <thead>
                              <tr className="text-stone-500 text-left">
                                <th className="py-1.5 font-medium">Month</th>
                                <th className="py-1.5 font-medium text-right">OPD</th>
                                <th className="py-1.5 font-medium text-right">IPD</th>
                                <th className="py-1.5 font-medium text-right">OT</th>
                                <th className="py-1.5 font-medium text-right">Revenue (INR)</th>
                              </tr>
                            </thead>
                            <tbody className="divide-y divide-stone-100">
                              {[...sorted].reverse().map((m, i) => (
                                <tr key={i}>
                                  <td className="py-1.5 num">{String(m.month).padStart(2, "0")}/{m.year}</td>
                                  <td className="py-1.5 text-right num">{fmt(m.opd_count)}</td>
                                  <td className="py-1.5 text-right num">{fmt(m.ipd_admissions)}</td>
                                  <td className="py-1.5 text-right num">{fmt(m.ot_cases)}</td>
                                  <td className="py-1.5 text-right num">{fmt(m.revenue_inr)}</td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        </div>
                      </section>
                    );
                  });
                })()
              )}
            </div>
          )}


          {section === "incidents" && (
            <section className="bg-white border border-stone-200 rounded-xl">
              <div className="px-5 py-3.5 border-b border-stone-100 flex items-center justify-between">
                <h2 className="text-sm font-semibold">
                  Incidents <span className="text-[11px] bg-stone-100 text-stone-600 rounded-full px-2 py-0.5 font-medium ml-1">{incidentsList.length}</span>
                </h2>
                <Link href={`/incidents/new?target=${id}`} className="text-[12px] text-brand font-medium">+ Report an incident</Link>
              </div>
              {incidentsList.length === 0 ? (
                <div className="px-5 py-12 text-center text-sm text-stone-500">
                  No incidents on this physician.
                </div>
              ) : (
                <div className="divide-y divide-stone-100">
                  {incidentsList.map((r) => {
                    const sevPill: Record<string, string> = {
                      low: "bg-stone-100 text-stone-700",
                      medium: "bg-amber-50 text-amber-800",
                      high: "bg-orange-50 text-orange-800",
                      critical: "bg-red-50 text-red-800",
                    };
                    const statusPill: Record<string, string> = {
                      open: "bg-emerald-50 text-emerald-700",
                      closed: "bg-stone-100 text-stone-600",
                      retracted: "bg-red-50 text-red-700",
                    };
                    const catLabel: Record<string, string> = {
                      clinical: "Clinical", patient_safety: "Patient safety", medical_error: "Medical error",
                      professionalism: "Professionalism", documentation: "Documentation",
                      etiquette: "Etiquette", vendor_compliance: "Vendor compliance", other: "Other",
                    };
                    const isRetracted = r.status === "retracted";
                    return (
                      <Link
                        key={r.id}
                        href={`/incidents/${r.id}`}
                        className={`block px-5 py-4 hover:bg-stone-50 ${isRetracted ? "opacity-70" : ""}`}
                      >
                        <div className="flex items-start gap-3">
                          <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-[11px] font-medium ${sevPill[r.severity] ?? "bg-stone-100 text-stone-700"}`}>
                            {r.severity}
                          </span>
                          <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-[11px] font-medium ${statusPill[r.status] ?? "bg-stone-100 text-stone-700"}`}>
                            {r.status}
                          </span>
                          <span className="text-[11px] text-stone-500 px-2 py-0.5 rounded-full bg-stone-50">
                            {catLabel[r.category] ?? r.category}
                          </span>
                          <div className="flex-1 min-w-0">
                            <div className={`text-sm font-medium ${isRetracted ? "line-through text-stone-500" : "text-stone-900"}`}>
                              {r.anonymous_flag ? "Anonymous submission" : (r.submitter_label || "Submitter")}
                            </div>
                            <div className="text-xs text-stone-500 mt-0.5 truncate">{r.narrative_preview}</div>
                            <div className="text-[11px] text-stone-400 mt-1">
                              {timeAgo(r.submitted_at)}
                              {r.reply_count > 0 ? ` · ${r.reply_count} ${r.reply_count === 1 ? "reply" : "replies"}` : ""}
                              {isRetracted && r.retraction_reason ? ` · retracted: ${r.retraction_reason}` : ""}
                            </div>
                          </div>
                        </div>
                      </Link>
                    );
                  })}
                </div>
              )}
            </section>
          )}


          {section === "feedback" && (
            <div className="space-y-4">
              {feedback.length === 0 ? (
                <section className="bg-white border border-stone-200 rounded-xl py-12 text-center">
                  <div className="text-sm text-stone-700 font-medium">No patient feedback yet</div>
                  <div className="text-xs text-stone-500 mt-1">
                    Super-admin uploads quarterly CSVs from{" "}
                    <Link href="/admin/patient-feedback" className="text-brand font-medium">/admin/patient-feedback</Link>.
                  </div>
                </section>
              ) : (
                (() => {
                  // Group by hospital
                  const byHospital = new Map<string, FeedbackRow[]>();
                  for (const f of feedback) {
                    const list = byHospital.get(f.hospital_code) ?? [];
                    list.push(f);
                    byHospital.set(f.hospital_code, list);
                  }
                  const fmt = (n: number | null) => n === null || n === undefined ? "—" : Number(n).toLocaleString("en-IN");
                  return Array.from(byHospital.entries()).map(([code, list]) => {
                    const sorted = [...list].sort((a, b) => a.feedback_period.localeCompare(b.feedback_period));
                    const labels = sorted.map((m) => m.feedback_period);
                    const csatPoints = sorted.map((m, i) => ({ x: i, y: (m.csat_score ?? null) as number | null, label: labels[i] }));
                    const complaintPoints = sorted.map((m, i) => ({ x: i, y: (m.complaint_count ?? null) as number | null, label: labels[i] }));
                    const last = sorted[sorted.length - 1];
                    return (
                      <section key={code} className="bg-white border border-stone-200 rounded-xl">
                        <div className="px-5 py-3.5 border-b border-stone-100 flex items-center justify-between">
                          <h2 className="text-sm font-semibold">{code} <span className="text-[11px] text-stone-500 font-normal">· last {sorted.length} periods</span></h2>
                        </div>
                        <div className="grid grid-cols-2 gap-3 px-5 py-4">
                          <div className="bg-stone-50 rounded-lg p-3">
                            <div className="flex items-baseline justify-between mb-1.5">
                              <div className="text-[11px] font-medium text-stone-500 tracking-wider uppercase">CSAT</div>
                              <div className="text-sm font-semibold num">{fmt(last?.csat_score)}</div>
                            </div>
                            <MiniLineChart points={csatPoints} color="#0f766e" />
                          </div>
                          <div className="bg-stone-50 rounded-lg p-3">
                            <div className="flex items-baseline justify-between mb-1.5">
                              <div className="text-[11px] font-medium text-stone-500 tracking-wider uppercase">Complaints</div>
                              <div className="text-sm font-semibold num">{fmt(last?.complaint_count)}</div>
                            </div>
                            <MiniLineChart points={complaintPoints} color="#dc2626" />
                          </div>
                        </div>
                        <div className="border-t border-stone-100 px-5 py-3 max-h-[260px] overflow-y-auto">
                          <table className="w-full text-xs">
                            <thead>
                              <tr className="text-stone-500 text-left">
                                <th className="py-1.5 font-medium">Period</th>
                                <th className="py-1.5 font-medium text-right">CSAT</th>
                                <th className="py-1.5 font-medium text-right">Complaints</th>
                                <th className="py-1.5 font-medium">Source</th>
                              </tr>
                            </thead>
                            <tbody className="divide-y divide-stone-100">
                              {[...sorted].reverse().map((m, i) => (
                                <tr key={i}>
                                  <td className="py-1.5 num">{m.feedback_period}</td>
                                  <td className="py-1.5 text-right num">{fmt(m.csat_score)}</td>
                                  <td className="py-1.5 text-right num">{fmt(m.complaint_count)}</td>
                                  <td className="py-1.5 text-stone-600">{m.source ?? "—"}</td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        </div>
                      </section>
                    );
                  });
                })()
              )}
            </div>
          )}

          {!["overview", "engagements", "qualifications", "metrics", "incidents", "feedback"].includes(section) && (
            <div className="bg-white border border-stone-200 rounded-xl py-16 text-center">
              <div className="text-sm text-stone-500">This section ships in the next sprint.</div>
            </div>
          )}
        </div>
      </main>

      {addEng && (
        <AddEngagementModal
          physicianId={id!}
          defaultSpecialty={physician.primary_specialty}
          onClose={() => setAddEng(false)}
          onSaved={() => { setAddEng(false); load(); }}
        />
      )}
      {addQual && (
        <AddQualificationModal
          physicianId={id!}
          onClose={() => setAddQual(false)}
          onSaved={() => { setAddQual(false); load(); }}
        />
      )}
      {addPriv && (
        <AddPrivilegeModal
          physicianId={id!}
          defaultSpecialty={physician.primary_specialty}
          onClose={() => setAddPriv(false)}
          onSaved={() => { setAddPriv(false); load(); }}
        />
      )}
    </>
  );
}
