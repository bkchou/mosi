import type { Metadata } from "next";
import { Geist, Geist_Mono, Newsreader } from "next/font/google";
import "./globals.css";

const geistSans = Geist({ variable: "--font-geist-sans", subsets: ["latin"] });
const geistMono = Geist_Mono({ variable: "--font-geist-mono", subsets: ["latin"] });
const newsreader = Newsreader({ variable: "--font-newsreader", subsets: ["latin"] });

export const metadata: Metadata = {
  metadataBase: new URL("https://mosi.bkchou.com"),
  title: { default: "MOSI · Market-Implied Forecasts", template: "%s · MOSI" },
  description: "Monitoring The Situation: Market-Implied Forecasts.",
  icons: { icon: "/favicon.svg", shortcut: "/favicon.svg" },
  openGraph: {
    title: "MOSI · Market-Implied Forecasts",
    description: "Monitoring The Situation: Market-Implied Forecasts.",
    url: "https://mosi.bkchou.com",
    siteName: "MOSI",
    images: [{ url: "/og.png", width: 1536, height: 1024, alt: "MOSI market intelligence dashboard" }],
    type: "website",
  },
  twitter: { card: "summary_large_image", title: "MOSI · Market-Implied Forecasts", description: "Monitoring The Situation: Market-Implied Forecasts.", images: ["/og.png"] },
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="en"><body className={`${geistSans.variable} ${geistMono.variable} ${newsreader.variable}`}>{children}</body></html>;
}
