import type { Metadata, Viewport } from "next";
import { Analytics } from "@vercel/analytics/react";
import { Orbitron, Inter, JetBrains_Mono } from "next/font/google";
import "./globals.css";
import Providers from "@/providers";

// Three-family font system. Each is exposed as a CSS variable so SCSS
// tokens in src/styles/_tokens.scss can reference them. See the style
// guide (docs/UI_STYLE_GUIDE.md §4.2) for which family to use where.

const orbitron = Orbitron({
  subsets: ["latin"],
  display: "swap",
  variable: "--font-orbitron",
});

const inter = Inter({
  subsets: ["latin"],
  display: "swap",
  variable: "--font-inter",
});

const jetbrainsMono = JetBrains_Mono({
  subsets: ["latin"],
  display: "swap",
  variable: "--font-jetbrains-mono",
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
    <html
      lang="en"
      className={`${orbitron.variable} ${inter.variable} ${jetbrainsMono.variable}`}
    >
      <body suppressHydrationWarning>
        <Providers>{children}</Providers>
        <Analytics />
      </body>
    </html>
  );
}
