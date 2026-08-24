// A 0–100 meter — same visual pattern already used for check-in progress on
// the scan and event-management pages (h-2 rounded-full track + fill), reused
// here rather than inventing a second look for the same kind of value.

export default function ProgressBar({
  label,
  pct,
  detail,
}: {
  label: string;
  pct: number;
  detail?: string;
}) {
  const clamped = Math.max(0, Math.min(100, pct));
  return (
    <div>
      <div className="mb-1 flex items-center justify-between text-sm">
        <span className="truncate pr-2">{label}</span>
        <span className="shrink-0 text-muted">
          {clamped}%{detail ? ` · ${detail}` : ""}
        </span>
      </div>
      <div className="h-2 overflow-hidden rounded-full bg-surface2">
        <div className="h-full rounded-full bg-ok transition-all" style={{ width: `${clamped}%` }} />
      </div>
    </div>
  );
}
