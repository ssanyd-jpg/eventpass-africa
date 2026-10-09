"use client";

import { useEffect, useRef, useState } from "react";

// Session D — gate/vendor scan results need to read at a glance from a few
// meters away, so this takes over the whole screen instead of sitting in a
// small card below the fold. Colors are hard-coded rather than themed
// (same reasoning as the pre-existing VIP takeover screen this mirrors):
// this must stay maximum-contrast regardless of the viewer's light/dark
// preference or the high-contrast toggle, since it IS the high-contrast
// moment.
export type ScanResultTone = "success" | "warn" | "danger";

const TONE_STYLE: Record<ScanResultTone, { bg: string; fg: string; ringTrack: string }> = {
  // Deep grounds get white text; the amber ground (below) is light enough
  // that white would fail contrast, so it gets dark text instead — same
  // dark-on-bright-gold pairing the existing VIP screen already uses.
  success: { bg: "#046c4e", fg: "#ffffff", ringTrack: "rgba(255,255,255,0.3)" },
  warn: { bg: "#d97706", fg: "#1a1300", ringTrack: "rgba(0,0,0,0.25)" },
  danger: { bg: "#a30f0f", fg: "#ffffff", ringTrack: "rgba(255,255,255,0.3)" },
};

// Chaap brand sting — the panther video replaces the plain color+icon
// screen for the two tones gate staff see most ("warn" states like already
// checked in / payment pending keep the original plain screen on purpose;
// they're soft re-scan prompts, not a hard grant/deny, so the dramatic
// video would be the wrong tone for them). Each video has its own baked-in
// tint, "GRANTED"/"ACCESS DENIED" text and sound — see
// public/scan-results/README (if present) or the brand asset source for
// how these were produced. durationMs here is a safety-net auto-clear in
// case the video's own `onEnded` event never fires (load failure, autoplay
// fully blocked, etc.) — normal playback always finishes first and clears
// via onEnded instead.
const TONE_VIDEO: Partial<Record<ScanResultTone, { src: string; durationMs: number }>> = {
  success: { src: "/scan-results/granted.mp4", durationMs: 2300 },
  danger: { src: "/scan-results/denied.mp4", durationMs: 4300 },
};

const RING_SIZE = 56;
const RING_STROKE = 5;
const RING_RADIUS = (RING_SIZE - RING_STROKE) / 2;
const RING_CIRCUMFERENCE = 2 * Math.PI * RING_RADIUS;

function CountdownRing({ durationMs }: { durationMs: number }) {
  const [depleted, setDepleted] = useState(false);
  useEffect(() => {
    // rAF, not a 0ms timeout — the dash-offset transition only animates
    // from the value present at first paint, so the "full ring" state has
    // to actually hit the screen for one frame before flipping.
    const raf = requestAnimationFrame(() => setDepleted(true));
    return () => cancelAnimationFrame(raf);
  }, []);
  return (
    <svg
      width={RING_SIZE}
      height={RING_SIZE}
      viewBox={`0 0 ${RING_SIZE} ${RING_SIZE}`}
      className="absolute right-5 top-5"
      aria-hidden="true"
    >
      <circle cx={RING_SIZE / 2} cy={RING_SIZE / 2} r={RING_RADIUS} fill="none" stroke="currentColor" strokeOpacity={0.25} strokeWidth={RING_STROKE} />
      <circle
        cx={RING_SIZE / 2}
        cy={RING_SIZE / 2}
        r={RING_RADIUS}
        fill="none"
        stroke="currentColor"
        strokeWidth={RING_STROKE}
        strokeLinecap="round"
        strokeDasharray={RING_CIRCUMFERENCE}
        strokeDashoffset={depleted ? RING_CIRCUMFERENCE : 0}
        className="scan-countdown-ring"
        style={{ transform: "rotate(-90deg)", transformOrigin: "50% 50%", transitionDuration: `${durationMs}ms` }}
      />
    </svg>
  );
}

// Fills the full-screen takeover behind the info bars. Tries to play with
// its own sound first (the tap/scan that produced this result is itself a
// user gesture in the click-to-check-in path, which satisfies most
// browsers' autoplay-with-sound policy; the NFC/camera auto-detect paths
// aren't a gesture, so some browsers will still reject it) — on rejection
// it falls back to muted playback rather than showing nothing.
function ResultVideo({ src, onEnded }: { src: string; onEnded: () => void }) {
  const videoRef = useRef<HTMLVideoElement>(null);
  useEffect(() => {
    const v = videoRef.current;
    if (!v) return;
    v.muted = false;
    const playPromise = v.play();
    if (playPromise && typeof playPromise.catch === "function") {
      playPromise.catch(() => {
        v.muted = true;
        v.play().catch(() => {
          // Still blocked even muted (extremely locked-down embed context)
          // — onEnded will never fire, but the safety-net timer in the
          // parent still clears the overlay after durationMs.
        });
      });
    }
  }, []);
  return (
    <video
      ref={videoRef}
      src={src}
      playsInline
      autoPlay
      onEnded={onEnded}
      className="absolute inset-0 h-full w-full object-cover"
    />
  );
}

export default function ScanResultOverlay({
  tone,
  icon,
  title,
  subtitle,
  hint,
  code,
  durationMs = 3000,
  onDone,
}: {
  tone: ScanResultTone;
  icon: string;
  title: string;
  subtitle?: string | null;
  hint?: string | null;
  code?: string;
  durationMs?: number;
  onDone: () => void;
}) {
  const style = TONE_STYLE[tone];
  const video = TONE_VIDEO[tone];
  const effectiveDurationMs = video?.durationMs ?? durationMs;

  const onDoneRef = useRef(onDone);
  onDoneRef.current = onDone;
  useEffect(() => {
    // Safety net only — when a video is present, onEnded normally fires
    // and clears the overlay first; this just guarantees the gate scanner
    // can never get stuck on a frozen result screen if playback fails.
    const timer = setTimeout(() => onDoneRef.current(), effectiveDurationMs);
    return () => clearTimeout(timer);
  }, [effectiveDurationMs]);

  if (video) {
    return (
      <div role="alert" className="fixed inset-0 z-50 overflow-hidden bg-black text-white">
        <ResultVideo src={video.src} onEnded={() => onDoneRef.current()} />
        <CountdownRing durationMs={effectiveDurationMs} />
        <div className="absolute inset-x-0 top-0 bg-black/60 px-5 pb-4 pt-5 text-center backdrop-blur-sm">
          <p className="text-[clamp(1.5rem,7vw,2.5rem)] font-extrabold leading-[1.1] tracking-[0.01em]">{title}</p>
          {subtitle && <p className="mt-1 text-[clamp(1rem,4.5vw,1.5rem)] font-bold opacity-95">{subtitle}</p>}
        </div>
        {(hint || code) && (
          <div className="absolute inset-x-0 bottom-0 bg-black/60 px-5 pb-4 pt-3 text-center backdrop-blur-sm">
            {hint && <p className="mx-auto max-w-sm text-[clamp(0.9rem,3.5vw,1.0625rem)] font-medium opacity-90">{hint}</p>}
            {code && (
              <p className="mt-1 font-mono text-[clamp(0.85rem,3.2vw,1rem)] font-semibold tracking-widest opacity-80">{code}</p>
            )}
          </div>
        )}
      </div>
    );
  }

  return (
    <div
      role="alert"
      className="fixed inset-0 z-50 flex flex-col items-center justify-center gap-4 p-6 text-center"
      style={{ backgroundColor: style.bg, color: style.fg }}
    >
      <CountdownRing durationMs={effectiveDurationMs} />
      <span className="text-[clamp(3rem,20vw,7rem)] leading-none" aria-hidden="true">{icon}</span>
      <p className="text-[clamp(2rem,11vw,3.5rem)] font-extrabold leading-[1.05] tracking-[0.01em]">{title}</p>
      {subtitle && <p className="text-[clamp(1.1rem,5.5vw,1.75rem)] font-bold">{subtitle}</p>}
      {hint && <p className="max-w-sm text-[clamp(0.95rem,4vw,1.125rem)] font-medium opacity-90">{hint}</p>}
      {code && (
        <p className="font-mono text-[clamp(0.9rem,3.5vw,1.125rem)] font-semibold tracking-widest opacity-80">{code}</p>
      )}
    </div>
  );
}
