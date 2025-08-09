import type { Metadata, Viewport } from "next";
import { Analytics } from "@vercel/analytics/react";
import { Orbitron } from "next/font/google";
import "./globals.css";
import Providers from "@/providers";

const orbitron = Orbitron({
  subsets: ["latin"],
  display: "swap",
});

export const metadata: Metadata = {
  title: "Stellar Nomad",
  description:
    "A space exploration game built with React Three Fiber and Next.js",
};

export const viewport: Viewport = {
  themeColor: "black",
  colorScheme: "dark",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
  <body className={orbitron.className} suppressHydrationWarning>
        <Providers>{children}</Providers>
        <Analytics />
      </body>
    </html>
  );
}
