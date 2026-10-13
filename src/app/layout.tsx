import type { Metadata, Viewport } from "next";
import localFont from "next/font/local";
import { Montserrat } from "next/font/google";
import "./globals.css";
import Providers from "@/components/Providers";
import Navbar from "@/components/Navbar";
import ClientChrome from "@/components/ClientChrome";

// Brand primary typeface "Helium" is not a distributable web font; Montserrat
// (the brand's specified secondary/fallback face) is used for all UI text.
const montserrat = Montserrat({
  subsets: ["latin"],
  variable: "--font-montserrat",
  weight: ["400", "500", "600", "700", "800", "900"],
});
const geistMono = localFont({
  src: "./fonts/GeistMonoVF.woff",
  variable: "--font-geist-mono",
  weight: "100 900",
});

const title = "Chaap — Event Ticketing That Works Offline";
const description =
  "Browse events, sell tickets, scan gate entry, and settle vendor payouts same-day — all with 100% offline capability.";

export const metadata: Metadata = {
  metadataBase: new URL(process.env.NEXTAUTH_URL ?? "https://chaap.africa"),
  title,
  description,
  manifest: "/manifest.json",
  icons: { icon: "/favicon.ico", apple: "/chaap-apple-touch-icon.png" },
  openGraph: {
    title,
    description,
    url: "/",
    siteName: "Chaap",
    images: [{ url: "/brand/chaap-hero-poster.webp", width: 1280, height: 719, alt: "Chaap — one wristband, every gate" }],
    locale: "en_US",
    type: "website",
  },
  twitter: {
    card: "summary_large_image",
    title,
    description,
    images: ["/brand/chaap-hero-poster.webp"],
  },
};

// Matches --surface-app in globals.css (the "sunset" theme's page background)
// so the browser status bar / PWA splash screen never flashes the old
// deep-blue brand color this theme replaced.
export const viewport: Viewport = {
  themeColor: "#211A1D",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" className="dark">
      <body className={`${montserrat.variable} ${geistMono.variable} antialiased`}>
        <Providers>
          <div className="flex min-h-screen flex-col">
            <Navbar />
            <main className="flex-1">{children}</main>
          </div>
          <ClientChrome />
        </Providers>
      </body>
    </html>
  );
}
