import type { Metadata } from "next";
import "./globals.css";
import "./chat.css";
import "./screens.css";
import "@copilotkit/react-core/v2/styles.css";
import { headers } from "next/headers";
import { Providers } from "./providers";
import { ACTOR_ROLE_HEADER } from "@/lib/zone/authorize";

export const metadata: Metadata = {
  title: "Even Studio",
  description: "Interactive answers for Even Healthcare governance work.",
  icons: { icon: "/icon.svg" },
};

export default async function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  // src/proxy.ts overwrites this header on every request; an empty value shows nothing role-gated.
  const role = (await headers()).get(ACTOR_ROLE_HEADER) ?? "";
  return (
    <html lang="en">
      <body className="antialiased">
        <Providers role={role}>{children}</Providers>
      </body>
    </html>
  );
}
