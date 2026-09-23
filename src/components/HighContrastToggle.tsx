"use client";

// A real ≥48px touch target, not a small icon button — gate/vendor staff
// are tapping this with gloved hands or in bright sun, same reasoning as
// every other control on the scan pages this session.
export default function HighContrastToggle({
  highContrast,
  onToggle,
}: {
  highContrast: boolean;
  onToggle: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-pressed={highContrast}
      className={`inline-flex min-h-12 items-center gap-2 rounded-full border px-4 text-sm font-bold transition ${
        highContrast
          ? "border-accent bg-accent text-black"
          : "border-border bg-surface2 text-foreground hover:border-accent"
      }`}
    >
      <span aria-hidden="true">☀️</span>
      {highContrast ? "High contrast: ON" : "High contrast"}
    </button>
  );
}
