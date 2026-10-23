"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { screenForPage } from "@/lib/zone/access";
import { useAccess } from "@/lib/zone/access-context";

// Paths are relative to the /studio basePath (next/link and usePathname add and strip it).
export const NAV_ITEMS = [
  { href: "/overview", label: "Overview" },
  { href: "/physicians", label: "Physicians" },
  { href: "/audit-findings", label: "Audit findings" },
  { href: "/document-audits", label: "Document audits" },
  { href: "/cdmss", label: "CDMSS" },
  { href: "/rmo-inbox", label: "RMO inbox" },
  { href: "/incidents", label: "e-IRIS incidents" },
  { href: "/feedback", label: "Patient feedback" },
  { href: "/surgical", label: "Surgical" },
  { href: "/onboarding", label: "Onboarding" },
  { href: "/admin/users", label: "Admin" },
  { href: "/", label: "Chat" },
] as const;

export function isActive(pathname: string | null, href: string): boolean {
  if (!pathname) return false;
  if (href === "/") return pathname === "/";
  return pathname === href || pathname.startsWith(`${href}/`);
}

export function StudioNav() {
  const pathname = usePathname();
  const { canScreen } = useAccess();
  const items = NAV_ITEMS.filter((item) => {
    const screen = screenForPage(item.href);
    return screen === null || canScreen(screen);
  });
  return (
    <nav className="studio-nav" aria-label="Studio sections">
      <span className="studio-nav-brand">Even Studio</span>
      <ul>
        {items.map((item) => (
          <li key={item.href}>
            <Link href={item.href} aria-current={isActive(pathname, item.href) ? "page" : undefined}>
              {item.label}
            </Link>
          </li>
        ))}
      </ul>
    </nav>
  );
}
