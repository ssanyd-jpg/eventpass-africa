// Pure route-gating logic for an attendee-flagged account (isAttendeeOrg
// true) trying to reach an organiser/staff tool — mirrors resolveVendorRedirect
// (src/lib/vendor-access.ts) and resolveSponsorRedirect (src/lib/sponsor-access.ts)
// exactly: pulled out of middleware.ts so it's directly unit-testable (see
// those files' own header comments for the full reasoning).
//
// /vendor/* and /sponsor/* get no special case here — those are already
// confined to their own VENDOR/SPONSOR magic-link session type by
// resolveVendorRedirect/resolveSponsorRedirect above, which apply
// regardless of isAttendeeOrg (an ordinary attendee or organiser account
// hitting a vendor/sponsor dashboard is already bounced to /vendor/login or
// /sponsor/login today, since neither carries role "VENDOR"/"SPONSOR").
//
// Returns the bare pathname to redirect to, or null if `path` should be
// allowed through as-is — same bare-pathname shape as resolveVendorRedirect/
// resolveSponsorRedirect's return value. middleware.ts attaches the
// `?notice=organiser-only` query param itself when it sees this result,
// since that's the one thing this particular redirect needs that the
// sibling functions' plain redirects don't.
export function resolveAttendeeRedirect(
  session: { isAttendeeOrg?: boolean } | null | undefined,
  path: string
): string | null {
  if (!session?.isAttendeeOrg) return null;

  // Bare "/dashboard" is deliberately excluded — it shows its own friendly
  // in-page message instead of a hard redirect (see OrganiserOnlyMessage.tsx
  // in src/app/dashboard/page.tsx), so an attendee who lands there isn't
  // bounced away before they can read why or find the "Browse events"/
  // "Create an organiser account" links.
  const isOrganiserOnlyRoute = path.startsWith("/dashboard/") || path.startsWith("/scan/");
  if (!isOrganiserOnlyRoute) return null;

  return "/events";
}
