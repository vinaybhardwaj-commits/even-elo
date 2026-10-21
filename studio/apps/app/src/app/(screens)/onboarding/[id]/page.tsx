import { OnboardingPrescreenScreen } from "@/components/screens/onboarding-screens";

export const metadata = { title: "VC pre-screen · Even Studio" };

export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <OnboardingPrescreenScreen id={id} />;
}
