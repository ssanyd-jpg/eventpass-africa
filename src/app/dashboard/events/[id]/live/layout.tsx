import type { Metadata } from "next";

// The page itself is a Client Component (it polls, so it needs hooks) —
// Next's Metadata API only works from a Server Component, hence a small
// layout just for this route segment. The site already has a manifest +
// service worker (see src/app/layout.tsx), so any URL in scope is already
// installable as a standalone PWA; appleWebApp is the one thing that isn't
// covered by the manifest — iOS Safari ignores it for "Add to Home Screen"
// and needs its own meta tags to open full-screen instead of in a browser
// chrome.
export const metadata: Metadata = {
  title: "Live Monitor — Chaap",
  appleWebApp: {
    capable: true,
    statusBarStyle: "black-translucent",
    title: "Live Monitor",
  },
};

export default function LiveEventLayout({ children }: { children: React.ReactNode }) {
  return children;
}
