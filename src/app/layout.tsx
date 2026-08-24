import type { Metadata, Viewport } from "next";
import localFont from "next/font/local";
import { Montserrat } from "next/font/google";
import "./globals.css";
import Providers from "@/components/Providers";
import Navbar from "@/components/Navbar";

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

export const metadata: Metadata = {
  title: "EventPass Africa — Event Ticketing That Works Offline",
  description:
    "Browse events, sell tickets, scan gate entry, and settle vendor payouts same-day — all with 100% offline capability.",
  manifest: "/manifest.json",
  icons: { icon: "/icon.svg", apple: "/icon.svg" },
};

export const viewport: Viewport = {
  themeColor: "#001A3D",
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
        </Providers>
      </body>
    </html>
  );
}
