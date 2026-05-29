"use client";

import { useEffect, useState } from "react";

interface Phys { id: string; full_name: string; preferred_name: string | null; primary_specialty: string | null; registration_number: string | null; registration_council: string | null; registration_expiry: string | null; email: string | null; phone: string | null; date_joined_network: string | null; current_status: string }
interface Eng { id: string; category: string; status: string; start_date: string | null; hospital_code: string; hospital_name: string }
interface Qual { id: string; degree: string; institution: string | null; institution_tier: string | null; year_completed: number | null; country: string | null; verified: boolean; has_file: boolean; file_filename: string | null }
interface Priv { id: string; procedure_or_specialty: string; is_core: boolean; granted_date: string | null; expires_at: string | null; withdrawn_date: string | null; hospital_code: string }

const CAT_LABEL: Record<string, string> = { provisional: "Provisional", active: "Active", visiting_consultant: "Visiting Consultant", locum_tenens: "Locum", affiliate: "Affiliate" };

function fmt(d: string | null) { return d ? d.slice(0, 10) : "—"; }

function readFile(f: File): Promise<{ filename: string; mime: string; size_bytes: number; data: string }> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => { const s = String(r.result); resolve({ filename: f.name, mime: f.type, size_bytes: f.size, data: s.split(",")[1] ?? "" }); };
    r.onerror = reject;
    r.readAsDataURL(f);
  });
}

export default function PortalHome() {
  const [me, setMe] = useState<Phys | null>(null);
  const [engs, setEngs] = useState<Eng[]>([]);
  const [quals, setQuals] = useState<Qual[]>([]);
  const [privs, setPrivs] = useState<Priv[]>([]);
  const [tab, setTab] = useState<"overview" | "qualifications" | "privileges">("overview");
  const [loading, setLoading] = useState(true);

  // add-qual form
  const [showAdd, setShowAdd] = useState(false);
  const [qDegree, setQDegree] = useState(""); const [qInst, setQInst] = useState(""); const [qYear, setQYear] = useState(""); const [qCountry, setQCountry] = useState("");
  const [qFile, setQFile] = useState<File | null>(null);
  const [qErr, setQErr] = useState<string | null>(null); const [qBusy, setQBusy] = useState(false);
  const [editId, setEditId] = useState<string | null>(null);
  const [eDegree, setEDegree] = useState(""); const [eInst, setEInst] = useState(""); const [eYear, setEYear] = useState("");

  function loadAll() {
    setLoading(true);
    Promise.all([
      fetch("/api/portal/me").then((r) => r.json()),
      fetch("/api/portal/qualifications").then((r) => r.json()),
      fetch("/api/portal/privileges").then((r) => r.json()),
    ]).then(([m, q, p]) => {
      if (m.ok) { setMe(m.physician); setEngs(m.engagements ?? []); }
      if (q.ok) setQuals(q.rows ?? []);
      if (p.ok) setPrivs(p.rows ?? []);
    }).finally(() => setLoading(false));
  }
  useEffect(() => { loadAll(); }, []);

  async function logout() { await fetch("/api/portal/auth/logout", { method: "POST" }); window.location.href = "/portal/login"; }

  async function addQual(e: React.FormEvent) {
    e.preventDefault(); setQErr(null);
    if (!qDegree.trim()) { setQErr("Degree is required."); return; }
    setQBusy(true);
    try {
      let file = undefined;
      if (qFile) {
        if (qFile.size > 2 * 1024 * 1024) { setQErr("File exceeds 2 MB."); setQBusy(false); return; }
        file = await readFile(qFile);
      }
      const r = await fetch("/api/portal/qualifications", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ degree: qDegree.trim(), institution: qInst.trim() || null, year_completed: qYear ? Number(qYear) : null, country: qCountry.trim() || null, file }) });
      const j = await r.json();
      if (!r.ok || !j.ok) { setQErr(j.error || "Failed to add."); setQBusy(false); return; }
      setShowAdd(false); setQDegree(""); setQInst(""); setQYear(""); setQCountry(""); setQFile(null);
      loadAll();
    } finally { setQBusy(false); }
  }

  function startEdit(q: Qual) { setEditId(q.id); setEDegree(q.degree); setEInst(q.institution ?? ""); setEYear(q.year_completed ? String(q.year_completed) : ""); }
  async function saveEdit(qid: string) {
    const r = await fetch(`/api/portal/qualifications/${qid}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ degree: eDegree.trim(), institution: eInst.trim() || null, year_completed: eYear ? Number(eYear) : null }) });
    const j = await r.json();
    if (!r.ok || !j.ok) { alert(j.error || "Edit failed"); return; }
    setEditId(null); loadAll();
  }

  const TABS: Array<[typeof tab, string]> = [["overview", "Overview"], ["qualifications", "Qualifications"], ["privileges", "Current Privileges"]];
  const SOON = ["Report feedback", "About me", "Resign"];

  return (
    <main className="min-h-screen bg-stone-50">
      <header className="bg-white border-b border-stone-200 sticky top-0 z-10">
        <div className="max-w-[900px] mx-auto px-6 h-14 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <span className="inline-flex items-center justify-center w-7 h-7 rounded-lg bg-teal-600 text-white text-[11px] font-bold">EPI</span>
            <span className="font-semibold text-sm">Even Physician Portal</span>
          </div>
          <div className="flex items-center gap-3 text-sm text-stone-500">
            <span>{me?.full_name ?? ""}</span>
            <button onClick={logout} className="text-stone-500 hover:text-stone-900">Sign out</button>
          </div>
        </div>
      </header>

      <div className="max-w-[900px] mx-auto px-6 py-6">
        {/* tab bar */}
        <div className="flex flex-wrap gap-1.5 mb-5">
          {TABS.map(([k, label]) => (
            <button key={k} onClick={() => setTab(k)} className={`px-3 py-1.5 rounded-lg text-[13px] font-medium ${tab === k ? "bg-teal-600 text-white" : "bg-white border border-stone-200 text-stone-700 hover:bg-stone-50"}`}>{label}</button>
          ))}
          {SOON.map((s) => (<span key={s} className="px-3 py-1.5 rounded-lg text-[13px] font-medium bg-stone-100 text-stone-400" title="Coming soon">{s}</span>))}
        </div>

        {loading ? <div className="text-sm text-stone-500">Loading…</div> : (
        <>
          {tab === "overview" && me && (
            <div className="space-y-4">
              <section className="bg-white border border-stone-200 rounded-xl p-5">
                <h2 className="text-sm font-semibold mb-3">Your profile</h2>
                <div className="grid grid-cols-2 gap-y-2 gap-x-6 text-sm">
                  <div><span className="text-stone-500">Name</span><div className="font-medium">{me.full_name}</div></div>
                  <div><span className="text-stone-500">Specialty</span><div className="font-medium">{me.primary_specialty ?? "—"}</div></div>
                  <div><span className="text-stone-500">Email</span><div className="font-medium">{me.email ?? "—"}</div></div>
                  <div><span className="text-stone-500">Phone</span><div className="font-medium">{me.phone ?? "—"}</div></div>
                  <div><span className="text-stone-500">Registration</span><div className="font-medium">{me.registration_number ?? "—"} {me.registration_council ? `· ${me.registration_council}` : ""}</div></div>
                  <div><span className="text-stone-500">License expires</span><div className="font-medium">{fmt(me.registration_expiry)}</div></div>
                </div>
              </section>
              <section className="bg-white border border-stone-200 rounded-xl p-5">
                <h2 className="text-sm font-semibold mb-3">Engagements</h2>
                {engs.length === 0 ? <div className="text-sm text-stone-500">No engagements on record.</div> : (
                  <div className="space-y-2">
                    {engs.map((e) => (
                      <div key={e.id} className="flex items-center gap-3 text-sm border border-stone-100 rounded-lg px-3 py-2">
                        <span className="font-medium">{e.hospital_code}</span>
                        <span className="text-stone-500">{e.hospital_name}</span>
                        <span className="ml-auto px-2 py-0.5 rounded-full text-[11px] font-medium bg-stone-100 text-stone-700">{CAT_LABEL[e.category] ?? e.category}</span>
                        <span className={`px-2 py-0.5 rounded-full text-[11px] font-medium ${e.status === "active" ? "bg-emerald-50 text-emerald-700" : "bg-stone-100 text-stone-600"}`}>{e.status}</span>
                      </div>
                    ))}
                  </div>
                )}
              </section>
            </div>
          )}

          {tab === "qualifications" && (
            <section className="bg-white border border-stone-200 rounded-xl">
              <div className="px-5 py-3.5 border-b border-stone-100 flex items-center justify-between">
                <h2 className="text-sm font-semibold">Qualifications</h2>
                <button onClick={() => setShowAdd((v) => !v)} className="text-[12px] text-teal-700 font-medium">{showAdd ? "Cancel" : "+ Add qualification"}</button>
              </div>
              {showAdd && (
                <form onSubmit={addQual} className="px-5 py-4 border-b border-stone-100 bg-stone-50 space-y-3">
                  <div className="grid grid-cols-2 gap-3">
                    <div><label className="block text-xs font-medium text-stone-500 mb-1">Degree *</label><input value={qDegree} onChange={(e) => setQDegree(e.target.value)} className="w-full px-3 py-2 border border-stone-200 rounded-lg text-sm" placeholder="MBBS, MS Ortho…" /></div>
                    <div><label className="block text-xs font-medium text-stone-500 mb-1">Institution</label><input value={qInst} onChange={(e) => setQInst(e.target.value)} className="w-full px-3 py-2 border border-stone-200 rounded-lg text-sm" /></div>
                    <div><label className="block text-xs font-medium text-stone-500 mb-1">Year</label><input value={qYear} onChange={(e) => setQYear(e.target.value.replace(/\D/g, "").slice(0, 4))} className="w-full px-3 py-2 border border-stone-200 rounded-lg text-sm num" /></div>
                    <div><label className="block text-xs font-medium text-stone-500 mb-1">Country</label><input value={qCountry} onChange={(e) => setQCountry(e.target.value)} className="w-full px-3 py-2 border border-stone-200 rounded-lg text-sm" /></div>
                  </div>
                  <div><label className="block text-xs font-medium text-stone-500 mb-1">Certificate (PDF/PNG/JPEG, optional, ≤2 MB)</label><input type="file" accept="application/pdf,image/png,image/jpeg" onChange={(e) => setQFile(e.target.files?.[0] ?? null)} className="text-sm" /></div>
                  {qErr && <div className="text-sm text-red-700 bg-red-50 border border-red-200 rounded-lg px-3 py-2">{qErr}</div>}
                  <div className="text-[11px] text-stone-400">Submitted qualifications start unverified — an administrator reviews them.</div>
                  <button type="submit" disabled={qBusy} className="bg-teal-600 text-white px-4 py-2 rounded-lg text-sm font-medium hover:bg-teal-700 disabled:opacity-50">{qBusy ? "Adding…" : "Add"}</button>
                </form>
              )}
              {quals.length === 0 ? <div className="px-5 py-10 text-center text-sm text-stone-500">No qualifications yet.</div> : (
                <div className="divide-y divide-stone-100">
                  {quals.map((q) => (
                    <div key={q.id} className="px-5 py-3">
                      {editId === q.id ? (
                        <div className="space-y-2">
                          <div className="grid grid-cols-3 gap-2">
                            <input value={eDegree} onChange={(e) => setEDegree(e.target.value)} className="px-2 py-1.5 border border-stone-200 rounded text-sm" placeholder="Degree" />
                            <input value={eInst} onChange={(e) => setEInst(e.target.value)} className="px-2 py-1.5 border border-stone-200 rounded text-sm" placeholder="Institution" />
                            <input value={eYear} onChange={(e) => setEYear(e.target.value.replace(/\D/g, "").slice(0, 4))} className="px-2 py-1.5 border border-stone-200 rounded text-sm num" placeholder="Year" />
                          </div>
                          <div className="flex gap-2"><button onClick={() => saveEdit(q.id)} className="text-xs bg-teal-600 text-white px-3 py-1.5 rounded-lg font-medium">Save</button><button onClick={() => setEditId(null)} className="text-xs text-stone-500">Cancel</button></div>
                        </div>
                      ) : (
                        <div className="flex items-center gap-3">
                          <div className="flex-1">
                            <div className="text-sm font-medium">{q.degree} {q.year_completed ? <span className="text-stone-400 font-normal">· {q.year_completed}</span> : null}</div>
                            <div className="text-xs text-stone-500">{q.institution ?? "—"}{q.has_file ? ` · 📎 ${q.file_filename ?? "certificate"}` : ""}</div>
                          </div>
                          <span className={`px-2 py-0.5 rounded-full text-[11px] font-medium ${q.verified ? "bg-emerald-50 text-emerald-700" : "bg-amber-50 text-amber-800"}`}>{q.verified ? "Verified" : "Pending verification"}</span>
                          {!q.verified && <button onClick={() => startEdit(q)} className="text-[12px] text-teal-700 font-medium">Edit</button>}
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </section>
          )}

          {tab === "privileges" && (
            <section className="bg-white border border-stone-200 rounded-xl">
              <div className="px-5 py-3.5 border-b border-stone-100"><h2 className="text-sm font-semibold">Current Privileges <span className="text-[11px] text-stone-400 font-normal">· read-only</span></h2></div>
              {privs.filter((p) => !p.withdrawn_date).length === 0 ? <div className="px-5 py-10 text-center text-sm text-stone-500">No active privileges on record.</div> : (
                <div className="divide-y divide-stone-100">
                  {privs.filter((p) => !p.withdrawn_date).map((p) => (
                    <div key={p.id} className="px-5 py-3 flex items-center gap-3 text-sm">
                      <span className={`px-2 py-0.5 rounded-full text-[11px] font-medium ${p.is_core ? "bg-brand/10 text-brand" : "bg-violet-50 text-violet-700"}`}>{p.is_core ? "Core" : "Special"}</span>
                      <div className="flex-1"><span className="font-medium">{p.procedure_or_specialty}</span> <span className="text-stone-400">· {p.hospital_code}</span></div>
                      {p.expires_at && <span className="text-[11px] text-stone-500">expires {fmt(p.expires_at)}</span>}
                    </div>
                  ))}
                </div>
              )}
            </section>
          )}
        </>
        )}
      </div>
    </main>
  );
}
