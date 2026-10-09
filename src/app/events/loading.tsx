import { Skeleton } from "@/components/Skeleton";

// Next.js route-level loading UI for /events — this page is an async Server
// Component (Prisma + ads lookups), so without this file a navigation here
// just freezes on the old page until data resolves. Mirrors the real
// layout's shape (max-w-6xl shell, filter card, 3-col card grid) so nothing
// jumps when the real content swaps in, same approach as Skeleton.tsx's
// SkeletonPage.
export default function EventsLoading() {
  return (
    <div className="mx-auto max-w-6xl px-4 pb-16 pt-8 sm:px-6">
      <div className="mb-8">
        <Skeleton className="mb-2 h-8 w-56" />
        <Skeleton className="h-4 w-72" />
      </div>

      <div className="card mb-8 grid grid-cols-1 gap-4 p-5 sm:grid-cols-2 lg:grid-cols-[minmax(0,1.5fr)_minmax(0,1fr)_minmax(0,1fr)_minmax(22rem,2fr)]">
        {Array.from({ length: 4 }).map((_, i) => (
          <div key={i} className="space-y-1.5">
            <Skeleton className="h-3 w-16" />
            <Skeleton className="h-10 w-full" />
          </div>
        ))}
      </div>

      <div className="grid grid-cols-1 gap-5 sm:grid-cols-2 lg:grid-cols-3">
        {Array.from({ length: 6 }).map((_, i) => (
          <div key={i} className="card overflow-hidden">
            <Skeleton className="aspect-[16/9] w-full" />
            <div className="space-y-2 p-4">
              <Skeleton className="h-4 w-4/5" />
              <Skeleton className="h-3 w-2/5" />
              <Skeleton className="h-3 w-1/3" />
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
