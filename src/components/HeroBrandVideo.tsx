"use client";

import { useEffect, useRef } from "react";

// Homepage hero's brand panther clip. Autoplay is skipped under
// prefers-reduced-motion — the poster frame (which already bakes in the
// panther, Kilimanjaro, DNA helix and "CHAAP AFRICA" wordmark) stands on its
// own as a static brand shot, so reduced-motion users lose nothing but the
// motion itself.
//
// Desktop/tablet only (see page.tsx's `hidden lg:block` wrapper) — kept off
// phones to avoid burning mobile data on this market's often-metered
// connections. CSS display:none on the wrapper does NOT stop a <video src>
// from being fetched, so `src` is deliberately left off the element itself
// and only ever attached here, in JS, after confirming a desktop-width
// viewport — a mobile load never requests the video file at all, only the
// lightweight poster.
export default function HeroBrandVideo({ src, poster }: { src: string; poster: string }) {
  const videoRef = useRef<HTMLVideoElement>(null);

  useEffect(() => {
    const v = videoRef.current;
    if (!v) return;
    const isDesktop = window.matchMedia("(min-width: 1024px)").matches;
    if (!isDesktop) return;
    const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (reduceMotion) return;
    v.src = src;
    v.play().catch(() => {});
  }, [src]);

  return (
    <video
      ref={videoRef}
      poster={poster}
      muted
      loop
      playsInline
      preload="none"
      className="h-full w-full object-cover"
    />
  );
}
