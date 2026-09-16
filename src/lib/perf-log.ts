// Session 22 performance audit — response-time logging for API routes.
//
// The literal ask was "add this to the Next.js middleware", but
// src/middleware.ts's own matcher deliberately excludes every /api/* path
// ("API handlers do their own auth checks" — see its header comment), and
// it runs on the Edge runtime, which this app's API routes don't (they use
// Prisma, which needs Node). Widening the matcher to intercept API routes
// just to log timings would touch a security-sensitive, deliberately-scoped
// config for a logging feature — not worth the risk. This is the same idea
// applied where it can actually run: call `logIfSlow` at the end of a route
// handler, and it only ever prints for the slow case.
export function logIfSlow(routeName: string, startedAt: number, thresholdMs = 500) {
  const durationMs = Date.now() - startedAt;
  if (durationMs > thresholdMs) {
    console.warn(`[perf] ${routeName} took ${durationMs}ms (over ${thresholdMs}ms budget)`);
  }
  return durationMs;
}
