import { PhysicianScreen } from "@/components/screens/physician-screen";

export const metadata = { title: "Physician 360 · Even Studio" };

export default async function PhysicianPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <PhysicianScreen id={id} />;
}
