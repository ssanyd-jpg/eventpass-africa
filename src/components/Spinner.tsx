// Session 23 — the one loading indicator every page's data-fetch state uses,
// replacing plain "Loading…" text so a fetch in progress reads the same way
// everywhere (gate scanner, wallet terminal, timing/session scanners, the
// public event/leaderboard pages, live monitoring, the organiser dashboard).
export default function Spinner({ className = "" }: { className?: string }) {
  return (
    <svg
      className={`h-5 w-5 animate-spin text-muted ${className}`}
      viewBox="0 0 24 24"
      fill="none"
      aria-hidden="true"
    >
      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
      <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v4a4 4 0 00-4 4H4z" />
    </svg>
  );
}
