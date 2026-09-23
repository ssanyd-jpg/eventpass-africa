import type { CSSProperties } from "react";

// Overrides the same CSS custom properties tailwind.config.ts's colors map
// to (var(--background), var(--accent), etc.) — every existing bg-*/text-*
// utility class on a scan page picks this up automatically for free, no
// per-element className changes needed. Pure black/white/yellow, per the
// "bright outdoor use" spec — deliberately not derived from the brand
// palette, which is tuned for a screen indoors.
export const HIGH_CONTRAST_VARS = {
  "--background": "#000000",
  "--foreground": "#ffffff",
  "--surface": "#000000",
  "--surface-2": "#141414",
  "--border": "#ffffff",
  "--muted": "#f5f5f5",
  "--accent": "#facc15",
  "--accent-hover": "#fde047",
  "--accent-soft": "rgba(250, 204, 21, 0.25)",
  "--ok": "#4ade80",
  "--warn": "#facc15",
  "--danger": "#ff5252",
} as CSSProperties;
