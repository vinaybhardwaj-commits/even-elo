import { redirect } from "next/navigation";
import { getCurrentUser } from "@/lib/auth";
import { AdminShell } from "@/components/AdminShell";
import RcaClient from "@/components/safety/RcaClient";
export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export default async function Page() {
  const u = await getCurrentUser();
  if (!u || u.status !== "active" || !(u.is_super_admin || u.is_sgc_member)) redirect("/home");
  return (
    <AdminShell breadcrumbs={[{ label: "Governance", href: "/home" }, { label: "Safety incidents", href: "/safety" }, { label: "RCA" }]} title="Root cause analysis">
      <RcaClient />
    </AdminShell>
  );
}
