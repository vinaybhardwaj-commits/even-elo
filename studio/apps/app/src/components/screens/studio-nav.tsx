"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

// Paths are relative to the /studio basePath (next/link and usePathname add and strip it).
export const NAV_ITEMS = [
  { href: "/overview", label: "Overview" },
  { href: "/physicians", label: "Physicians" },
  { href: "/incidents", label: "e-IRIS incidents" },
  { href: "/feedback", label: "Patient feedback" },
  { href: "/", label: "Chat" },
] as const;

export function isActive(pathname: string | null, href: string): boolean {
  if (!pathname) return false;
  if (href === "/") return pathname === "/";
  return pathname === href || pathname.startsWith(`${href}/`);
}

export function StudioNav() {
  const pathname = usePathname();
  return (
    <nav className="studio-nav" aria-label="Studio sections">
      <span className="studio-nav-brand">Even Studio</span>
      <ul>
        {NAV_ITEMS.map((item) => (
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
