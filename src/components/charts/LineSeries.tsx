// Plain, server-renderable line/sparkline chart — no client JS, no charting
// library, pure SVG. Same visual language as BarSeries: a solid accent-
// colored stroke with a light fill underneath (mirrors BarSeries's
// opacity-based fill treatment), a native SVG <title> per point instead of
// a JS tooltip library, and the same "nothing to show yet" empty state tone.

export interface LineSeriesPoint {
  label: string;
  value: number;
}

export default function LineSeries({
  data,
  height = 96,
  color = "currentColor",
}: {
  data: LineSeriesPoint[];
  height?: number;
  color?: string;
}) {
  if (data.length === 0 || data.every((d) => d.value === 0)) {
    return <p className="py-6 text-center text-sm text-muted">Nothing to show yet.</p>;
  }

  const max = Math.max(...data.map((d) => d.value), 1);
  const width = 100; // percentage-based viewBox — scales to the container's actual width
  const stepX = data.length > 1 ? width / (data.length - 1) : 0;
  const points = data.map((d, i) => ({
    x: i * stepX,
    y: height - (d.value / max) * height,
  }));

  const linePath = points.map((p, i) => `${i === 0 ? "M" : "L"}${p.x.toFixed(2)},${p.y.toFixed(2)}`).join(" ");
  const last = points[points.length - 1];
  const areaPath = `${linePath} L${last.x.toFixed(2)},${height} L0,${height} Z`;

  return (
    <svg
      viewBox={`0 0 ${width} ${height}`}
      preserveAspectRatio="none"
      className="w-full text-accent"
      style={{ height }}
      role="img"
      aria-label={`Trend from ${data[0].label} to ${data[data.length - 1].label}`}
    >
      <path d={areaPath} fill={color} fillOpacity={0.12} stroke="none" />
      <path d={linePath} fill="none" stroke={color} strokeWidth={1.5} vectorEffect="non-scaling-stroke" />
      {points.map((p, i) => (
        <circle key={i} cx={p.x} cy={p.y} r={1.5} fill={color}>
          <title>{`${data[i].label}: ${data[i].value}`}</title>
        </circle>
      ))}
    </svg>
  );
}
