import Link from "next/link";
import { PositionChip } from "./PositionChip";

interface NavItem {
  label: string;
  href: string;
  /** When true, the link is rendered but greyed out — placeholder for routes that ship in later sprints. */
  pending?: boolean;
}

/**
 * Top nav bar — locked from EVEN-ELO-MOCKUPS.html mockup top header.
 * Same shape across user-facing and admin pages. Used by AppShell + AdminShell.
 */
export function TopNav({ nav = DEFAULT_NAV }: { nav?: NavItem[] } = {}) {
  return (
    <header className="bg-white border-b border-stone-200 sticky top-0 z-40">
      <div className="max-w-[1400px] mx-auto px-8 py-3 flex items-center justify-between">
        <div className="flex items-center gap-8">
          <Link href="/" className="flex items-center gap-2">
            <div className="w-8 h-8 rounded-lg flex items-center justify-center bg-brand">
              <span className="text-white text-sm font-bold">E</span>
            </div>
            <span className="font-semibold text-[15px]">Even-ELO</span>
            <span className="text-xs text-stone-400 font-medium tracking-wide">EHRC</span>
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
  { label: "Leaderboard", href: "/", pending: true },
  { label: "New Case", href: "/input/cases" },
  { label: "Anesthesia", href: "/input/anesthesia" },
  { label: "OT", href: "/input/ot" },
  { label: "Cases", href: "/admin/cases" },
  { label: "Admin", href: "/admin" },
];
