import { DocumentAuditScreen } from "@/components/screens/document-audit-screen";

export const metadata = { title: "Document audit · Even Studio" };

export default async function DocumentAuditPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <DocumentAuditScreen id={id} />;
}
