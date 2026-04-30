import Link from "next/link";

interface BreadcrumbCrumb {
  label: string;
  href?: string;
}

interface AdminShellProps {
  breadcrumbs: BreadcrumbCrumb[];
  title: string;
  subtitle?: string;
  actions?: React.ReactNode;
  children: React.ReactNode;
}

/**
 * Admin pages share the same top nav as user-facing pages plus a
 * page-level header with breadcrumbs, title, subtitle, and optional
 * action slot (e.g., "+ Add VC" button).
 *
 * Locked from EVEN-ELO-MOCKUPS.html admin styling — do not change without
 * updating the mockup first (PRD §3.1 / D35).
 */
export function AdminShell({
  breadcrumbs,
  title,
  subtitle,
  actions,
  children,
}: AdminShellProps) {
  return (
    <>
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
              <Link
                href="/admin"
                className="text-stone-600 hover:text-stone-900 hover:bg-stone-100 px-3 py-1.5 rounded-md text-[13px] font-medium transition"
              >
                Admin
              </Link>
            </nav>
          </div>
          <div className="flex items-center gap-3">
            <span className="flex items-center gap-2 text-xs font-medium px-3 py-1.5 rounded-lg border border-stone-200 text-stone-500">
              <span className="w-2 h-2 rounded-full bg-stone-400" />
              <span>
                Pre-ELO.2 — position picker lands next sprint
              </span>
            </span>
          </div>
        </div>
      </header>

      <main className="max-w-[1400px] mx-auto px-8 py-8">
        <div className="flex items-end justify-between mb-6">
          <div>
            <div className="flex items-center gap-2 text-xs text-stone-500 mb-2">
              {breadcrumbs.map((c, i) => (
                <span key={i} className="flex items-center gap-2">
                  {c.href ? (
                    <Link href={c.href} className="hover:text-stone-900">
                      {c.label}
                    </Link>
                  ) : (
                    <span className={i === breadcrumbs.length - 1 ? "text-stone-900 font-medium" : ""}>
                      {c.label}
                    </span>
                  )}
                  {i < breadcrumbs.length - 1 && <span>/</span>}
                </span>
              ))}
            </div>
            <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
            {subtitle && (
              <p className="text-sm text-stone-500 mt-1">{subtitle}</p>
            )}
          </div>
          {actions && <div className="flex items-center gap-2">{actions}</div>}
        </div>
        {children}
      </main>
    </>
  );
}
