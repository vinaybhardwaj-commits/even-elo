"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";

type Hosp = { code: string; name: string; vc: number; staff: number; total: number };
type Spec = { specialty: string; vc: number; staff: number; total: number };
type Member = { id: string; full_name: string; primary_specialty: string | null; category: string };

export default function CensusCards({ byHospital, bySpecialty }: { byHospital: Hosp[]; bySpecialty: Spec[] }) {
  const router = useRouter();
  const [drawer, setDrawer] = useState<{ title: string; members: Member[]; loading: boolean } | null>(null);

  async function open(title: string, params: Record<string, string>) {
    setDrawer({ title, members: [], loading: true });
    try {
      const r = await fetch(`/api/admin/census/members?${new URLSearchParams(params).toString()}`);
      const d = await r.json();
      setDrawer({ title, members: d.ok ? d.members : [], loading: false });
    } catch { setDrawer({ title, members: [], loading: false }); }
  }

  const Seg = ({ children, onClick }: { children: React.ReactNode; onClick: () => void }) => (
    <button onClick={onClick} className="tabular-nums hover:underline decoration-dotted underline-offset-2">{children}</button>
  );

  return (
    <section className="bg-white border border-stone-200 rounded-xl flex flex-col h-[420px]">
      <div className="px-5 py-3.5 border-b border-stone-100">
        <h2 className="text-sm font-semibold">Census</h2>
        <p className="text-[11px] text-stone-400 mt-0.5">By active engagement · click any number for names</p>
      </div>
      <div className="flex-1 overflow-y-auto">
        {/* By hospital */}
        <div className="px-5 py-3">
          <div className="text-[11px] font-medium text-stone-500 uppercase tracking-wider mb-1.5">By hospital</div>
          {byHospital.length === 0 ? <div className="text-sm text-stone-400 py-2">No active engagements.</div> : (
            <table className="w-full text-sm">
              <tbody>
                {byHospital.map((h) => (
                  <tr key={h.code} className="border-b border-stone-50 last:border-0">
                    <td className="py-1.5 text-stone-700">{h.name}</td>
                    <td className="py-1.5 text-right text-[12px] text-violet-700">
                      <Seg onClick={() => open(`${h.code} · VC`, { group: "hospital", hospital_code: h.code, bucket: "vc" })}>{h.vc} VC</Seg>
                    </td>
                    <td className="py-1.5 text-right text-[12px] text-stone-600">
                      <Seg onClick={() => open(`${h.code} · Staff`, { group: "hospital", hospital_code: h.code, bucket: "staff" })}>{h.staff} Staff</Seg>
                    </td>
                    <td className="py-1.5 text-right font-semibold text-stone-800">
                      <Seg onClick={() => open(`${h.code} · All`, { group: "hospital", hospital_code: h.code })}>{h.total}</Seg>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
        {/* By specialty */}
        <div className="px-5 py-3 border-t border-stone-100">
          <div className="text-[11px] font-medium text-stone-500 uppercase tracking-wider mb-1.5">By specialty</div>
          <div className="space-y-1">
            {bySpecialty.map((s) => (
              <button
                key={s.specialty}
                onClick={() => open(s.specialty, { group: "specialty", specialty: s.specialty })}
                className="w-full flex items-center justify-between py-1 hover:bg-stone-50 rounded px-1 -mx-1 transition text-left"
              >
                <span className="text-sm text-stone-700 truncate">{s.specialty}</span>
                <span className="shrink-0 text-right">
                  <span className="text-sm font-semibold text-stone-800 tabular-nums">{s.total}</span>
                  <span className="text-[11px] text-stone-400 ml-1.5">{s.vc} VC · {s.staff} Staff</span>
                </span>
              </button>
            ))}
          </div>
        </div>
      </div>

      {/* Slide-out drawer */}
      {drawer && (
        <div className="fixed inset-0 z-50" role="dialog" aria-modal="true">
          <div className="absolute inset-0 bg-black/30" onClick={() => setDrawer(null)} />
          <div className="absolute right-0 top-0 h-full w-full max-w-sm bg-white shadow-2xl flex flex-col">
            <div className="px-5 py-4 border-b border-stone-100 flex items-center justify-between">
              <div>
                <h3 className="text-sm font-semibold">{drawer.title}</h3>
                <p className="text-[11px] text-stone-400">{drawer.loading ? "Loading…" : `${drawer.members.length} ${drawer.members.length === 1 ? "doctor" : "doctors"}`}</p>
              </div>
              <button onClick={() => setDrawer(null)} className="text-stone-400 hover:text-stone-700 text-lg leading-none">×</button>
            </div>
            <div className="flex-1 overflow-y-auto divide-y divide-stone-50">
              {!drawer.loading && drawer.members.length === 0 && (
                <div className="px-5 py-10 text-center text-sm text-stone-500">No doctors in this group.</div>
              )}
              {drawer.members.map((m) => (
                <button
                  key={m.id}
                  onClick={() => router.push(`/physicians/${m.id}`)}
                  className="w-full text-left px-5 py-2.5 hover:bg-stone-50 transition flex items-center justify-between gap-2"
                >
                  <div className="min-w-0">
                    <div className="text-sm font-medium text-stone-800 truncate">{m.full_name}</div>
                    <div className="text-[12px] text-stone-500 truncate">{m.primary_specialty ?? "—"}</div>
                  </div>
                  <span className={`shrink-0 text-[10px] px-1.5 py-0.5 rounded-full font-medium ${m.category === "VC" ? "bg-violet-50 text-violet-700" : "bg-stone-100 text-stone-600"}`}>{m.category}</span>
                </button>
              ))}
            </div>
          </div>
        </div>
      )}
    </section>
  );
}
