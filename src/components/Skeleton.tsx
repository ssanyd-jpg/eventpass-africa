// Shared shimmer-block placeholders for data still loading from Dexie/the
// server, so a fetch never renders as a blank white area — see globals.css's
// .skeleton-shimmer keyframes for the actual animation.

export function Skeleton({ className = "" }: { className?: string }) {
  return <div className={`skeleton-shimmer rounded-lg bg-surface2 ${className}`} />;
}

export function SkeletonText({ lines = 1, className = "" }: { lines?: number; className?: string }) {
  return (
    <div className={`space-y-2 ${className}`}>
      {Array.from({ length: lines }).map((_, i) => (
        <Skeleton key={i} className={`h-3.5 ${i === lines - 1 && lines > 1 ? "w-3/5" : "w-full"}`} />
      ))}
    </div>
  );
}

// One card-shaped loading placeholder — mirrors the common "icon/thumbnail +
// title line + subtitle line" row shape used across dashboard list pages.
export function SkeletonCard({ className = "" }: { className?: string }) {
  return (
    <div className={`card flex items-center gap-4 p-4 ${className}`}>
      <Skeleton className="h-12 w-12 shrink-0" />
      <div className="flex-1 space-y-2">
        <Skeleton className="h-4 w-2/5" />
        <Skeleton className="h-3 w-1/3" />
      </div>
    </div>
  );
}

export function SkeletonList({ rows = 3 }: { rows?: number }) {
  return (
    <div className="space-y-3">
      {Array.from({ length: rows }).map((_, i) => (
        <SkeletonCard key={i} />
      ))}
    </div>
  );
}

// A full-page "still loading" state for pages that used to show a bare
// "Loading…" string — keeps each page's own max-width shell (passed in, so
// the skeleton lines up with the real content it's about to be replaced by)
// so nothing jumps when the real content swaps in.
export function SkeletonPage({ rows = 4, maxWidth = "max-w-2xl" }: { rows?: number; maxWidth?: string }) {
  return (
    <div className={`mx-auto ${maxWidth} px-4 pb-20 pt-16 sm:px-6`}>
      <Skeleton className="mb-2 h-4 w-24" />
      <Skeleton className="mb-6 h-8 w-64" />
      <SkeletonList rows={rows} />
    </div>
  );
}
