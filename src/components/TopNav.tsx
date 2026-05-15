"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { UserMenu, type UserSummary } from "./UserMenu";

interface NavItem {
  label: string;
  href: string;
  pending?: boolean;
  badge?: number;
}

/**
 * Top nav — EPI shell, client component.
 * Fetches /api/auth/me on mount + (if super_admin) polls pending-approval count.
 */
export function TopNav({ nav }: { nav?: NavItem[] } = {}) {
  const [user, setUser] = useState<UserSummary | null>(null);
  const [pendingCount, setPendingCount] = useState<number>(0);

  useEffect(() => {
    fetch("/api/auth/me")
      .then((r) => r.json())
      .then((j) => {
        if (j.ok && j.user) setUser(j.user as UserSummary);
      })
      .catch(() => undefined);
  }, []);

  useEffect(() => {
    if (!user?.is_super_admin) return;
    const fetchCount = () =>
      fetch("/api/admin/profiles?status=pending_approval")
        .then((r) => r.json())
        .then((j) => j.ok && setPendingCount((j.rows ?? []).length))
        .catch(() => undefined);
    fetchCount();
  }, [user?.is_super_admin]);

  const showElo = !!user && (user.is_super_admin || user.is_sgc_member);
  const showAdmin = !!user && user.is_super_admin;
  const navItems: NavItem[] = nav ?? defaultNav(showElo, showAdmin, pendingCount);

  return (
    <header className="bg-white border-b border-stone-200 sticky top-0 z-40">
      <div className="max-w-[1400px] mx-auto px-8 py-3 flex items-center justify-between">
        <div className="flex items-center gap-8">
          <Link href="/home" className="flex items-center gap-2">
            <div className="w-8 h-8 rounded-lg flex items-center justify-center bg-brand">
              <span className="text-white text-[11px] font-bold tracking-wide">EPI</span>
            </div>
            <span className="font-semibold text-[15px]">Even Physician Index</span>
            {user?.hospital_code && (
              <span className="text-xs text-stone-400 font-medium tracking-wide">{user.hospital_code}</span>
            )}
          </Link>
          <nav className="flex items-center gap-1">
            {navItems.map((item) => (
              <Link
                key={item.href + item.label}
                href={item.href}
                className={
                  item.pending
                    ? "text-stone-400 cursor-not-allowed px-3 py-1.5 rounded-md text-[13px] font-medium pointer-events-none"
                    : "text-stone-600 hover:text-stone-900 hover:bg-stone-100 px-3 py-1.5 rounded-md text-[13px] font-medium transition flex items-center gap-1.5"
                }
              >
                {item.label}
                {item.pending && <span className="ml-1 text-[10px] text-stone-300">soon</span>}
                {item.badge ? (
                  <span className="ml-0.5 inline-flex items-center justify-center min-w-[18px] h-[18px] px-1.5 rounded-full bg-brand text-white text-[10px] font-medium">
                    {item.badge}
                  </span>
                ) : null}
              </Link>
            ))}
          </nav>
        </div>
        <div className="flex items-center gap-3">
          {user ? <UserMenu user={user} /> : <div className="w-8 h-8 rounded-full bg-stone-100" />}
        </div>
      </div>
    </header>
  );
}

function defaultNav(showElo: boolean, showAdmin: boolean, pending: number): NavItem[] {
  const items: NavItem[] = [
    { label: "Home", href: "/home" },
    { label: "Physicians", href: "/physicians" },
    { label: "Onboarding", href: "#", pending: true },
    { label: "Incidents", href: "#", pending: true },
  ];
  if (showElo) items.push({ label: "Even ELO", href: "/surgical-elo" });
  if (showAdmin) items.push({ label: "Admin", href: "/admin", badge: pending || undefined });
  return items;
}
