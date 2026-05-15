import Link from "next/link";
import { neon } from "@neondatabase/serverless";
import { TopNav } from "@/components/TopNav";

export const dynamic = "force-dynamic";
export const revalidate = 0;
export const fetchCache = "force-no-store";
export const runtime = "nodejs";

async function counts() {
  const url = process.env.DATABASE_URL;
  if (!url) return { pending: 0, active: 0, physicians: 0 };
  const sql = neon(url);
  const r = (await sql`
    SELECT
      (SELECT COUNT(*)::int FROM profiles WHERE status='pending_approval') AS pending,
      (SELECT COUNT(*)::int FROM profiles WHERE status='active')           AS active,
      (SELECT COUNT(*)::int FROM physicians)                               AS physicians
  `) as Array<{ pending: number; active: number; physicians: number }>;
  return r[0];
}

export default async function AdminIndex() {
  const c = await counts();
  return (
    <>
      <TopNav />
      <main className="max-w-[1400px] mx-auto px-8 py-8">
        <div className="mb-6">
          <h1 className="text-[22px] font-semibold tracking-tight">Admin</h1>
          <div className="text-sm text-stone-500 mt-1">Super-admin tools</div>
        </div>
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
          <Link href="/admin/pending" className="card bg-white border border-stone-200 rounded-xl p-5 hover:border-stone-300">
            <div className="text-[11px] font-medium text-stone-500 tracking-wider uppercase">Pending approvals</div>
            <div className="num text-3xl font-semibold mt-2">{c.pending}</div>
            <div className="text-[12px] text-brand font-medium mt-2">Open inbox →</div>
          </Link>
          <Link href="/admin/users" className="card bg-white border border-stone-200 rounded-xl p-5 hover:border-stone-300">
            <div className="text-[11px] font-medium text-stone-500 tracking-wider uppercase">Active users</div>
            <div className="num text-3xl font-semibold mt-2">{c.active}</div>
            <div className="text-[12px] text-brand font-medium mt-2">User directory →</div>
          </Link>
          <Link href="/physicians" className="card bg-white border border-stone-200 rounded-xl p-5 hover:border-stone-300">
            <div className="text-[11px] font-medium text-stone-500 tracking-wider uppercase">Physicians</div>
            <div className="num text-3xl font-semibold mt-2">{c.physicians}</div>
            <div className="text-[12px] text-brand font-medium mt-2">Roster →</div>
          </Link>
          <Link href="/admin/metrics" className="card bg-white border border-stone-200 rounded-xl p-5 hover:border-stone-300">
            <div className="text-[11px] font-medium text-stone-500 tracking-wider uppercase">Clinical metrics</div>
            <div className="num text-xl font-semibold mt-2 text-stone-700">CSV upload</div>
            <div className="text-[12px] text-brand font-medium mt-2">Open uploader →</div>
          </Link>
        </div>
      </main>
    </>
  );
}
