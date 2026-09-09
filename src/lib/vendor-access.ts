// Pure route-gating logic for VENDOR sessions, pulled out of middleware.ts
// so it's directly unit-testable — middleware.ts runs on the Edge runtime
// under next-auth's own request wrapper, which isn't something a plain
// Vitest test can construct/invoke the way it can call a plain function
// (same reasoning access-control.ts's isOpAllowedForRole is a separate,
// directly-testable function rather than inline logic in push/route.ts).
//
// Returns the pathname to redirect to, or null if `path` should be allowed
// through as-is.
export function resolveVendorRedirect(
  session: { role?: string; vendorId?: string } | null | undefined,
  path: string
): string | null {
  // A VENDOR session anywhere outside its own portal — "cannot access any
  // organiser or admin routes" is a blanket rule, not an enumerated list,
  // so this fires for every path (see middleware.ts's broadened matcher).
  if (session?.role === "VENDOR" && !path.startsWith("/vendor")) {
    return `/vendor/${session.vendorId}/dashboard`;
  }

  // The reverse: a non-VENDOR session (including no session at all), or a
  // vendor session trying a DIFFERENT vendor's dashboard by editing the id
  // in the address bar.
  const vendorDashboardMatch = path.match(/^\/vendor\/([^/]+)\/dashboard(\/|$)/);
  if (vendorDashboardMatch) {
    const requestedVendorId = decodeURIComponent(vendorDashboardMatch[1]);
    if (session?.role !== "VENDOR" || session.vendorId !== requestedVendorId) {
      return "/vendor/login";
    }
  }

  return null;
}
