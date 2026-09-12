// Pure route-gating logic for SPONSOR sessions, mirroring
// resolveVendorRedirect (src/lib/vendor-access.ts) exactly — pulled out of
// middleware.ts so it's directly unit-testable (see that file's own header
// comment for the full reasoning).
//
// Returns the pathname to redirect to, or null if `path` should be allowed
// through as-is.
export function resolveSponsorRedirect(
  session: { role?: string; sponsorId?: string } | null | undefined,
  path: string
): string | null {
  // A SPONSOR session anywhere outside its own portal — "cannot access any
  // organiser, vendor, or admin routes" is a blanket rule, not an
  // enumerated list, so this fires for every path (see middleware.ts's
  // broadened matcher) including /vendor.
  if (session?.role === "SPONSOR" && !path.startsWith("/sponsor")) {
    return `/sponsor/${session.sponsorId}/dashboard`;
  }

  // The reverse: a non-SPONSOR session (including no session at all), or a
  // sponsor session trying a DIFFERENT sponsor's dashboard by editing the
  // id in the address bar.
  const sponsorDashboardMatch = path.match(/^\/sponsor\/([^/]+)\/dashboard(\/|$)/);
  if (sponsorDashboardMatch) {
    const requestedSponsorId = decodeURIComponent(sponsorDashboardMatch[1]);
    if (session?.role !== "SPONSOR" || session.sponsorId !== requestedSponsorId) {
      return "/sponsor/login";
    }
  }

  return null;
}
