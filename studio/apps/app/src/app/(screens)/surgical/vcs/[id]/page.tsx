import { SurgicalVcScreen } from "@/components/screens/surgical-screens";

export const metadata = { title: "Visiting consultant · Even Studio" };

export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <SurgicalVcScreen id={id} />;
}
