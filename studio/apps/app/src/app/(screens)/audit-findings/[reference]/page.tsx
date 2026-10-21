import { AuditFindingScreen } from "@/components/screens/audit-finding-screen";

export const metadata = { title: "Audit finding · Even Studio" };

export default async function AuditFindingPage({ params }: { params: Promise<{ reference: string }> }) {
  const { reference } = await params;
  return <AuditFindingScreen reference={decodeURIComponent(reference)} />;
}
