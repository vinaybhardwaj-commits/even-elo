"use client";

import { usePathname } from "next/navigation";

const items = [
  { label: "Dashboard", href: "/safety#dashboard" },
  { label: "Queue", href: "/safety#queue" },
  { label: "Recurring patterns", href: "/safety#recurring" },
  { label: "Notifications", href: "/safety/notifications" },
];

/** Sticky sub-nav shown on every Safety screen — jump to any section/page. */
export default function SafetyNav() {
  const path = usePathname();
  return (
    <div className="sticky top-[56px] z-30 -mx-8 mb-6 border-b border-stone-200 bg-white/85 px-8 backdrop-blur">
      <nav className="flex items-center gap-1 overflow-x-auto py-2.5">
        <span className="mr-2 text-[11px] font-semibold uppercase tracking-wide text-stone-400">Incidents</span>
        {items.map((i) => {
          const active = i.href === "/safety/notifications" && path === "/safety/notifications";
          return (
            <a
              key={i.href}
              href={i.href}
              className={
                "whitespace-nowrap rounded-md px-3 py-1.5 text-[13px] font-medium transition " +
                (active ? "bg-stone-900 text-white" : "text-stone-600 hover:bg-stone-100 hover:text-stone-900")
              }
            >
              {i.label}
            </a>
          );
        })}
      </nav>
    </div>
  );
}
