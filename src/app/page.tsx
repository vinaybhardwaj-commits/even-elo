import Link from "next/link";

/**
 * Home placeholder.
 *
 * Replaced in ELO.6a (leaderboard) with the real / leaderboard page
 * per EVEN-ELO-MOCKUPS.html screen #1.
 */
export default function Home() {
  return (
    <main className="min-h-screen flex items-center justify-center px-6">
      <div className="max-w-xl w-full text-center">
        <div className="inline-flex items-center gap-2 mb-6">
          <div className="w-10 h-10 rounded-xl bg-brand flex items-center justify-center">
            <span className="text-white text-base font-bold">E</span>
          </div>
          <span className="font-semibold text-lg">Even-ELO</span>
          <span className="text-xs text-stone-400 font-medium tracking-wide ml-1">EHRC</span>
        </div>

        <h1 className="text-3xl font-semibold tracking-tight mb-3">Schema ready</h1>

        <p className="text-stone-500 mb-8 text-balance">
          ELO.1 complete — 8 tables migrated, 18 streams + 9 positions seeded, admin
          foundation live. Leaderboard ships in ELO.6a.
        </p>

        <Link
          href="/admin"
          className="inline-block bg-brand text-white px-4 py-2 rounded-lg text-sm font-medium hover:bg-brand-hover transition mb-8"
        >
          Open Admin →
        </Link>

        <div className="rounded-xl border border-stone-200 bg-white p-5 text-left text-sm">
          <div className="text-xs font-medium tracking-wider uppercase text-stone-500 mb-3">
            Build status
          </div>
          <div className="space-y-2 num">
            <div className="flex justify-between">
              <span className="text-stone-600">Sprint</span>
              <span className="font-medium">ELO.1 — Schema + admin foundation</span>
            </div>
            <div className="flex justify-between">
              <span className="text-stone-600">Status</span>
              <span className="font-medium text-emerald-700">✓ Deployed READY</span>
            </div>
            <div className="flex justify-between">
              <span className="text-stone-600">Next</span>
              <span className="font-medium">ELO.2 — Cases + position picker</span>
            </div>
            <div className="flex justify-between">
              <span className="text-stone-600">Spec (binding)</span>
              <span className="font-mono text-xs text-stone-500">EVEN-ELO-MOCKUPS.html</span>
            </div>
          </div>
        </div>

        <p className="text-xs text-stone-400 mt-8">
          Surgical Governance Committee — confidential, committee use only.
        </p>
      </div>
    </main>
  );
}
