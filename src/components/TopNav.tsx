import Link from "next/link";
import { PositionChip } from "./PositionChip";

interface NavItem {
  label: string;
  href: string;
  /** When true, the link is rendered but greyed out — placeholder for routes that ship in later sprints. */
  pending?: boolean;
}

/**
 * Top nav bar — EPI shell.
 *
 * EPI.0a: hosts the v1 ELO surfaces (now at /surgical-elo/*) under the new
 * EPI brand. EPI.0b will introduce a wider Home/Physicians/Onboarding/Incidents
 * top-nav and replace PositionChip with an auth-derived user menu.
 */
export function TopNav({ nav = DEFAULT_NAV }: { nav?: NavItem[] } = {}) {
  return (
    <header className="bg-white border-b border-stone-200 sticky top-0 z-40">
      <div className="max-w-[1400px] mx-auto px-8 py-3 flex items-center justify-between">
        <div className="flex items-center gap-8">
          <Link href="/surgical-elo" className="flex items-center gap-2">
            <div className="w-8 h-8 rounded-lg flex items-center justify-center bg-brand">
              <span className="text-white text-[11px] font-bold tracking-wide">EPI</span>
            </div>
            <span className="font-semibold text-[15px]">Even Physician Index</span>
            <span className="text-xs text-stone-400 font-medium tracking-wide">EHRC · Even ELO</span>
          </Link>
          <nav className="flex items-center gap-1">
            {nav.map((item) => (
              <Link
                key={item.href}
                href={item.href}
                className={
                  item.pending
                    ? "text-stone-400 cursor-not-allowed px-3 py-1.5 rounded-md text-[13px] font-medium pointer-events-none"
                    : "text-stone-600 hover:text-stone-900 hover:bg-stone-100 px-3 py-1.5 rounded-md text-[13px] font-medium transition"
                }
              >
                {item.label}
              </Link>
            ))}
          </nav>
        </div>
        <div className="flex items-center gap-3">
          <PositionChip />
        </div>
      </div>
    </header>
  );
}

const DEFAULT_NAV: NavItem[] = [
  { label: "Leaderboard", href: "/surgical-elo" },
  { label: "New Case", href: "/surgical-elo/input/cases" },
  { label: "Anesthesia", href: "/surgical-elo/input/anesthesia" },
  { label: "OT", href: "/surgical-elo/input/ot" },
  { label: "Med Sup", href: "/surgical-elo/input/ms" },
  { label: "Cases", href: "/surgical-elo/admin/cases" },
  { label: "Admin", href: "/surgical-elo/admin" },
];
