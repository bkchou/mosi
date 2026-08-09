import type { Metadata } from "next";
import { Geist, Geist_Mono, Newsreader } from "next/font/google";
import "./globals.css";

const geistSans = Geist({ variable: "--font-geist-sans", subsets: ["latin"] });
const geistMono = Geist_Mono({ variable: "--font-geist-mono", subsets: ["latin"] });
const newsreader = Newsreader({ variable: "--font-newsreader", subsets: ["latin"] });

export const metadata: Metadata = {
  metadataBase: new URL("https://mosi.bkchou.com"),
  title: { default: "MOSI · Monitoring The Situation", template: "%s · MOSI" },
  description: "A live dashboard for market-implied forecasts that matter.",
  icons: { icon: "/favicon.svg", shortcut: "/favicon.svg" },
  openGraph: {
    title: "MOSI · Monitoring The Situation",
    description: "Market-implied forecasts for the Fed and frontier AI models.",
    url: "https://mosi.bkchou.com",
    siteName: "MOSI",
    images: [{ url: "/og.png", width: 1536, height: 1024, alt: "MOSI market intelligence dashboard" }],
    type: "website",
  },
  twitter: { card: "summary_large_image", title: "MOSI · Monitoring The Situation", description: "Market-implied forecasts for the Fed and frontier AI models.", images: ["/og.png"] },
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="en"><body className={`${geistSans.variable} ${geistMono.variable} ${newsreader.variable}`}>{children}</body></html>;
}
