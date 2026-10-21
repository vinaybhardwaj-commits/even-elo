import type { Metadata } from "next";
import "./globals.css";
import "./chat.css";
import "./screens.css";
import "@copilotkit/react-core/v2/styles.css";
import { Providers } from "./providers";

export const metadata: Metadata = {
  title: "Even Studio",
  description: "Interactive answers for Even Healthcare governance work.",
  icons: { icon: "/icon.svg" },
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body className="antialiased">
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
