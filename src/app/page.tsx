import Link from "next/link";
import { AppShell } from "@/components/AppShell";

/**
 * Home placeholder.
 *
 * Replaced in ELO.6a (leaderboard) with the real / leaderboard page
 * per EVEN-ELO-MOCKUPS.html screen #1.
 */
export default function Home() {
  return (
    <AppShell>
      <main className="min-h-[calc(100vh-56px)] flex items-center justify-center px-6">
        <div className="max-w-xl w-full text-center">
          <h1 className="text-3xl font-semibold tracking-tight mb-3">
            Cases live · position picker live
          </h1>

          <p className="text-stone-500 mb-8 text-balance">
            ELO.2 complete — case lifecycle (continuous + catch-up) and the position picker are
            live. Leaderboard ships in ELO.6a.
          </p>

          <div className="flex gap-3 justify-center mb-10">
            <Link
              href="/input/cases"
              className="bg-brand text-white px-4 py-2 rounded-lg text-sm font-medium hover:bg-brand-hover transition"
            >
              Record a case →
            </Link>
            <Link
              href="/admin"
              className="border border-stone-200 hover:border-stone-300 text-stone-700 px-4 py-2 rounded-lg text-sm font-medium transition"
            >
              Admin
            </Link>
          </div>

          <div className="rounded-xl border border-stone-200 bg-white p-5 text-left text-sm">
            <div className="text-xs font-medium tracking-wider uppercase text-stone-500 mb-3">
              Build status
            </div>
            <div className="space-y-2 num">
              <div className="flex justify-between">
                <span className="text-stone-600">Sprint</span>
                <span className="font-medium">ELO.2 — Cases + position picker</span>
              </div>
              <div className="flex justify-between">
                <span className="text-stone-600">Status</span>
                <span className="font-medium text-emerald-700">✓ Deployed READY</span>
              </div>
              <div className="flex justify-between">
                <span className="text-stone-600">Next</span>
                <span className="font-medium">ELO.3a — Scoring engine pure logic</span>
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
    </AppShell>
  );
}
