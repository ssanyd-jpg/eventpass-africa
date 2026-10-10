import Link from "next/link";

// Next.js renders this for any unmatched route, and for an explicit
// notFound() call from any page — without it, both fell through to Next's
// bare default 404, which clashes with the dark brand everywhere else.
export default function NotFound() {
  return (
    <div className="mx-auto flex min-h-[70vh] max-w-lg flex-col items-center justify-center px-4 py-16 text-center">
      <span aria-hidden className="text-5xl">
        🎟️
      </span>
      <h1 className="mt-4 text-2xl font-bold">Page not found</h1>
      <p className="mt-2 text-sm text-muted">
        The page you&apos;re looking for doesn&apos;t exist, or may have moved.
      </p>
      <div className="mt-6 flex flex-wrap items-center justify-center gap-3">
        <Link href="/" className="btn-primary">
          Go home
        </Link>
        <Link href="/events" className="btn-secondary">
          Browse events
        </Link>
      </div>
    </div>
  );
}
