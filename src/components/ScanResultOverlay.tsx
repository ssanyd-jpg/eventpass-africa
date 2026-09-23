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
  const onDoneRef = useRef(onDone);
  onDoneRef.current = onDone;
  useEffect(() => {
    const timer = setTimeout(() => onDoneRef.current(), durationMs);
    return () => clearTimeout(timer);
  }, [durationMs]);

  return (
    <div
      role="alert"
      className="fixed inset-0 z-50 flex flex-col items-center justify-center gap-4 p-6 text-center"
      style={{ backgroundColor: style.bg, color: style.fg }}
    >
      <CountdownRing durationMs={durationMs} />
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
