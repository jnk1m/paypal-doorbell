import type { Metadata, Viewport } from "next";
import { Bricolage_Grotesque, DM_Mono } from "next/font/google";
import "./tokens.css"; // the look: palette, type scale, space, shape
import "./globals.css"; // structure and component classes, which read the tokens

// Two families, each with its reason:
//   Bricolage Grotesque: a friendly grotesque whose quirks show at display size and calm down at text size through its optical-size axis,
//   so one family carries the headline and the body.
//   DM Mono: a soft, round mono, used only for ids, times and code, so that the numbers a reader checks are set apart without shouting.
const sans = Bricolage_Grotesque({ subsets: ["latin"], axes: ["opsz"], display: "swap", variable: "--font-bricolage" });
const mono = DM_Mono({ subsets: ["latin"], weight: "400", display: "swap", variable: "--font-dm-mono" });

export const metadata: Metadata = {
  title: "Doorbell: a webhook gap finder for PayPal",
  description: "Doorbell finds the PayPal webhooks your shop never heard, shows the line of your code that dropped them, rings them again, and tells you exactly what it still cannot prove. Sandbox only, fictional data.",
};

export const viewport: Viewport = { width: "device-width", initialScale: 1 };

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${sans.variable} ${mono.variable}`}>
      <body>{children}</body>
    </html>
  );
}
