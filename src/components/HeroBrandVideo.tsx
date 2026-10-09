"use client";

import { useEffect, useRef } from "react";

// Homepage hero's brand panther clip. Autoplay is skipped under
// prefers-reduced-motion — the poster frame (which already bakes in the
// panther, Kilimanjaro, DNA helix and "CHAAP AFRICA" wordmark) stands on its
// own as a static brand shot, so reduced-motion users lose nothing but the
// motion itself.
//
// This element itself is visible at every width (see page.tsx) — only the
// video *file* is desktop/tablet-only, to avoid burning mobile data on this
// market's often-metered connections. CSS alone can't gate that: a
// display:none ancestor does NOT stop a <video src> from being fetched, so
// `src` is deliberately left off the element in markup and only ever
// attached here, in JS, after confirming a desktop-width viewport. Below
// that, the element just renders its `poster` image — a mobile load never
// requests the video file at all.
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
