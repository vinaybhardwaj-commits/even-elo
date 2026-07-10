"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import { UserMenu, type UserSummary } from "../UserMenu";
import { HospitalFilter } from "../HospitalFilter";

/**
 * ShellV2 — the redesigned governance shell (EPI Redesign PRD v1.4-LOCKED, phase R1).
 *
 * Grouped sidebar (People / Signals / Actions IA) + slim top bar. Rendered by
 * <TopNav> when NEXT_PUBLIC_UI_V2=1, so every page that renders the old top nav
 * (directly or via AppShell/AdminShell) gets the new chrome with zero page edits.
 * Content offset is applied via body.ui-v2 (globals.css) because page content is
 * a sibling of this component, not a child.
 *
 * R1 = chrome only: same routes, same role gates as the old TopNav
 * (Surgical Governance + Admin = super_admin; Incidents(/safety) = super_admin|SGO).
 * "Planned" teasers (OPD Gov, IPD Gov, Councils) are visible to EVERYONE (V, 2 Jul)
 * and greyed until their phases ship. OPD Governance flips live in R3.
 */

interface NavLeaf {
  label: string;
  href?: string; // absent = planned teaser
  show?: boolean;
  tag?: "soon";
}

interface NavGroup {
  label?: string; // undefined = ungrouped (Overview)
  items: NavLeaf[];
}

export function ShellV2() {
  const [user, setUser] = useState<UserSummary | null>(null);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const pathname = usePathname();

  useEffect(() => {
    fetch("/api/auth/me")
      .then((r) => r.json())
      .then((j) => {
        if (j.ok && j.user) setUser(j.user as UserSummary);
      })
      .catch(() => undefined);
  }, []);

  // Content offset for the fixed sidebar (see globals.css body.ui-v2 rule).
  useEffect(() => {
    document.body.classList.add("ui-v2");
    return () => document.body.classList.remove("ui-v2");
  }, []);

  // Close the mobile drawer on navigation.
  useEffect(() => {
    setDrawerOpen(false);
  }, [pathname]);

  const isSuper = !!user?.is_super_admin;
  const showIncidents = !!user && (user.is_super_admin || user.is_sgc_member);

  const groups: NavGroup[] = [
    { items: [{ label: "Overview", href: "/overview" }] },
    {
      label: "Physicians",
      items: [
        { label: "Roster", href: "/physicians" },
        { label: "Credentialing", href: "/onboarding" },
        { label: "Watchlist", href: "/overview#watchlist" },
      ],
    },
    {
      label: "Governance",
      items: [
        { label: "OPD Governance", href: "/opd-governance" },
        { label: "IPD Governance", tag: "soon" },
        { label: "Surgical Governance", href: "/surgical-governance", show: isSuper },
        { label: "Feedback", href: "/incidents" },
        { label: "Incidents", href: "/safety", show: showIncidents },
      ],
    },
    {
      // M&M Analyzer (PRD decision 13) — same SGC/super predicate as Incidents.
      label: "M&M",
      items: [
        { label: "M&M Cases", href: "/mm", show: showIncidents },
        { label: "Protocol-gap register", tag: "soon", show: showIncidents },
      ],
    },
    {
      label: "Councils",
      items: [{ label: "Meetings & Actions", tag: "soon" }],
    },
  ];

  const isActive = (href?: string) => {
    if (!href) return false;
    const base = href.split("#")[0];
    if (base === "/overview") return (pathname === "/overview" || pathname === "/home") && !href.includes("#");
    return pathname === base || pathname.startsWith(base + "/");
  };

  const sidebarInner = (
    <div className="flex h-full flex-col overflow-y-auto px-3 py-4">
      <Link href="/home" className="flex items-center gap-2.5 px-2 pb-4">
        <div className="flex h-7 w-7 items-center justify-center rounded-lg bg-brand">
          <span className="text-[12px] font-bold text-white">E</span>
        </div>
        <div className="leading-tight">
          <div className="text-[14px] font-semibold tracking-tight">Even Governance</div>
          <div className="text-[10.5px] font-medium text-stone-400">Physician Index</div>
        </div>
      </Link>

      {groups.map((group, gi) => {
        const visible = group.items.filter((i) => i.show !== false);
        if (visible.length === 0) return null;
        return (
          <div key={gi} className={group.label ? "mt-4" : ""}>
            {group.label && (
              <div className="px-2.5 pb-1 text-[10px] font-bold uppercase tracking-[0.09em] text-stone-400">
                {group.label}
              </div>
            )}
            {visible.map((item) =>
              item.href ? (
                <Link
                  key={item.label}
                  href={item.href}
                  className={
                    "flex items-center gap-2 rounded-lg px-2.5 py-[7px] text-[13.5px] font-medium transition " +
                    (isActive(item.href)
                      ? "bg-brand-softer font-semibold text-brand"
                      : "text-stone-600 hover:bg-stone-100 hover:text-stone-900")
                  }
                >
                  {item.label}
                </Link>
              ) : (
                <div
                  key={item.label}
                  className="flex cursor-default items-center gap-2 rounded-lg px-2.5 py-[7px] text-[13.5px] font-medium text-stone-300"
                  title="Planned — coming soon"
                >
                  {item.label}
                  <span className="ml-auto rounded-full bg-stone-100 px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wide text-stone-400">
                    soon
                  </span>
                </div>
              ),
            )}
          </div>
        );
      })}

      <div className="mt-auto border-t border-stone-100 pt-3">
        {isSuper && (
          <Link
            href="/admin"
            className={
              "flex items-center gap-2 rounded-lg px-2.5 py-[7px] text-[13.5px] font-medium transition " +
              (isActive("/admin")
                ? "bg-brand-softer font-semibold text-brand"
                : "text-stone-600 hover:bg-stone-100 hover:text-stone-900")
            }
          >
            Admin
          </Link>
        )}
      </div>
    </div>
  );

  return (
    <>
      {/* Desktop sidebar */}
      <aside className="fixed inset-y-0 left-0 z-30 hidden w-60 border-r border-stone-200 bg-white lg:block">
        {sidebarInner}
      </aside>

      {/* Mobile drawer */}
      {drawerOpen && (
        <div className="fixed inset-0 z-50 lg:hidden">
          <div
            className="absolute inset-0 bg-stone-900/30"
            onClick={() => setDrawerOpen(false)}
            aria-hidden
          />
          <aside className="absolute inset-y-0 left-0 w-64 bg-white shadow-xl">{sidebarInner}</aside>
        </div>
      )}

      {/* Top bar */}
      <header className="sticky top-0 z-40 border-b border-stone-200 bg-white">
        <div className="flex min-h-14 items-center gap-3 px-4 py-2 sm:px-6">
          <button
            type="button"
            onClick={() => setDrawerOpen(true)}
            className="rounded-md p-1.5 text-stone-500 hover:bg-stone-100 lg:hidden"
            aria-label="Open navigation"
          >
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
              <line x1="4" y1="6" x2="20" y2="6" />
              <line x1="4" y1="12" x2="20" y2="12" />
              <line x1="4" y1="18" x2="20" y2="18" />
            </svg>
          </button>
          {user && <HospitalFilter />}
          <div className="ml-auto flex items-center gap-2.5">
            <Link
              href="/guide"
              title="Credentialing & governance guide"
              className="flex h-8 w-8 items-center justify-center rounded-lg border border-stone-200 text-[13px] font-semibold text-stone-500 hover:bg-stone-50 hover:text-stone-900"
            >
              ?
            </Link>
            {user ? <UserMenu user={user} /> : <div className="h-8 w-8 rounded-full bg-stone-100" />}
          </div>
        </div>
      </header>
    </>
  );
}
