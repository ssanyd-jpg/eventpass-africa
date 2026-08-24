// Plain, server-renderable bar list/chart — no client JS. Used for every
// trend and ranking section on the analytics pages: a day-bucketed series
// (many thin bars, sparse labels) or a short ranked list (few bars, every
// bar labeled). Knows nothing about dates or currency — callers pre-format
// `displayValue`.
//
// A dense day-series gets a native SVG <title> per bar (a free hover
// tooltip with zero client JS) instead of a permanent on-chart label, since
// labeling all 30 bars would collide; a short ranked list shows its value
// directly since there's room and no hover is needed to read it.

export interface BarSeriesPoint {
  label: string;
  value: number;
  displayValue: string;
}

export default function BarSeries({
  data,
  emptyLabel,
}: {
  data: BarSeriesPoint[];
  emptyLabel: string;
}) {
  if (data.length === 0 || data.every((d) => d.value === 0)) {
    return <p className="py-6 text-center text-sm text-muted">{emptyLabel}</p>;
  }

  const max = Math.max(...data.map((d) => d.value), 1);
  const dense = data.length > 10;

  if (dense) {
    // Day-trend rendering: a row of thin vertical bars, height-encoded,
    // rounded top corners, a 2px gap between bars, native tooltip per bar.
    return (
      <div className="flex h-24 items-end gap-[2px]" role="img" aria-label={emptyLabel}>
        {data.map((d, i) => (
          <div
            key={i}
            className="min-w-[2px] flex-1 rounded-t bg-accent/80 transition hover:bg-accent"
            style={{ height: `${Math.max((d.value / max) * 100, d.value > 0 ? 4 : 1)}%` }}
            title={`${d.label}: ${d.displayValue}`}
          />
        ))}
      </div>
    );
  }

  // Ranked-list rendering: one labeled horizontal bar per entry.
  return (
    <div className="space-y-2.5">
      {data.map((d, i) => (
        <div key={i}>
          <div className="mb-1 flex items-center justify-between text-sm">
            <span className="truncate pr-2">{d.label}</span>
            <span className="shrink-0 font-semibold">{d.displayValue}</span>
          </div>
          <div className="h-2 overflow-hidden rounded-full bg-surface2">
            <div
              className="h-full rounded-full bg-accent"
              style={{ width: `${Math.max((d.value / max) * 100, d.value > 0 ? 2 : 0)}%` }}
            />
          </div>
        </div>
      ))}
    </div>
  );
}
