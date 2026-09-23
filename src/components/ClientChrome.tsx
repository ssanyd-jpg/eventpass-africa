"use client";

import dynamic from "next/dynamic";

// Session E, item 6 — none of these three need to be part of the initial
// bundle every page pays for: they're pure client chrome with no SEO/first-
// paint value (a bottom nav, an install banner, a keyboard-scroll side
// effect). `ssr: false` moves each into its own chunk fetched after
// hydration instead of blocking it — `dynamic(..., { ssr: false })` is only
// legal inside a Client Component, which is why this wrapper exists rather
// than calling it straight from the (Server Component) root layout.
const BottomNav = dynamic(() => import("./BottomNav"), { ssr: false });
const InstallPrompt = dynamic(() => import("./InstallPrompt"), { ssr: false });
const KeyboardAwareScroll = dynamic(() => import("./KeyboardAwareScroll"), { ssr: false });

export default function ClientChrome() {
  return (
    <>
      <BottomNav />
      <InstallPrompt />
      <KeyboardAwareScroll />
    </>
  );
}
