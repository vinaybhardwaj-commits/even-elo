import { redirect } from "next/navigation";
import { getCurrentPhysician } from "@/lib/physician-auth";
import { PortalLogout } from "@/components/PortalLogout";

export const dynamic = "force-dynamic";

export default async function PortalHome() {
  const me = await getCurrentPhysician();
  if (!me) redirect("/portal/login");
  const first = me.full_name.replace(/^(dr\.?|prof\.?|mr\.?|ms\.?|mrs\.?)\s+/i, "").split(/\s+/)[0];
  return (
    <main className="min-h-screen bg-stone-50">
      <header className="bg-white border-b border-stone-200">
        <div className="max-w-[900px] mx-auto px-6 h-14 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <span className="inline-flex items-center justify-center w-7 h-7 rounded-lg bg-teal-600 text-white text-[11px] font-bold">EPI</span>
            <span className="font-semibold text-sm">Even Physician Portal</span>
          </div>
          <div className="flex items-center gap-3 text-sm text-stone-500">
            <span>{me.full_name}</span>
            <PortalLogout />
          </div>
        </div>
      </header>
      <div className="max-w-[900px] mx-auto px-6 py-10">
        <h1 className="text-[22px] font-semibold tracking-tight">Welcome, {first}</h1>
        <p className="text-sm text-stone-500 mt-1">This is your self-service portal. Your profile, qualifications, privileges, feedback, and resignation tools are being added next.</p>
        <div className="mt-6 grid grid-cols-2 sm:grid-cols-3 gap-3">
          {["Overview","Qualifications","Current Privileges","Report feedback","About me","Resign"].map((t) => (
            <div key={t} className="bg-white border border-stone-200 rounded-xl p-4 text-sm text-stone-400">{t}<div className="text-[11px] mt-1">Coming soon</div></div>
          ))}
        </div>
      </div>
    </main>
  );
}
