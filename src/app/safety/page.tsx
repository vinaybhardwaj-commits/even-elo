import { redirect } from "next/navigation";
import { getCurrentUser } from "@/lib/auth";
import { AdminShell } from "@/components/AdminShell";
import QueueClient from "@/components/safety/QueueClient";
export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export default async function Page() {
  const u = await getCurrentUser();
  if (!u || u.status !== "active" || !(u.is_super_admin || u.is_sgc_member)) redirect("/home");
  return (
    <AdminShell breadcrumbs={[{ label: "Governance", href: "/home" }, { label: "Safety incidents" }]} title="Safety incidents">
      <QueueClient />
    </AdminShell>
  );
}
