"use client";

import { useEffect } from "react";

// Route-segment error boundary — catches a render/data-fetch crash anywhere
// under the app and swaps in this screen instead of Next's bare default
// error page, which clashed with the dark brand everywhere else. Doesn't
// cover a crash in the root layout itself (that needs global-error.tsx,
// which can't rely on the app's own layout/Navbar at all) — not worth the
// extra surface for how rarely a layout-level crash happens here.
export default function ErrorBoundary({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error("[app:error]", error);
  }, [error]);

  return (
    <div className="mx-auto flex min-h-[70vh] max-w-lg flex-col items-center justify-center px-4 py-16 text-center">
      <span aria-hidden className="text-5xl">
        ⚠️
      </span>
      <h1 className="mt-4 text-2xl font-bold">Something went wrong</h1>
      <p className="mt-2 text-sm text-muted">
        That&apos;s on us — try again, or head back home.
      </p>
      <div className="mt-6 flex flex-wrap items-center justify-center gap-3">
        <button type="button" onClick={() => reset()} className="btn-primary">
          Try again
        </button>
        <a href="/" className="btn-secondary">
          Go home
        </a>
      </div>
    </div>
  );
}
