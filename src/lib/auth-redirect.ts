// Where a brand-new signup lands right after account creation — pulled out
// as its own pure function (rather than an inline ternary in
// src/app/register/page.tsx) so the mapping itself is unit-testable without
// a browser/jsdom harness, consistent with this codebase's convention of
// keeping deterministic logic in src/lib and UI components thin.
export type AccountType = "ATTENDEE" | "ORGANISER";

export function getPostSignupRedirect(accountType: AccountType): string {
  return accountType === "ATTENDEE" ? "/events" : "/dashboard/events/new";
}

// Where an existing account lands right after signing IN (as opposed to
// getPostSignupRedirect above, for right after signing UP) — same
// pure-function-pulled-out-of-the-page-component reasoning. The login page's
// Attendee/Organiser tabs are cosmetic framing only (which subtitle copy
// shows) and never reach this function: the account's own isAttendeeOrg flag
// is always authoritative for where it actually lands, same as
// isOrganiser's own doc comment in Navbar.tsx treats it as decisive. A
// callbackUrl (set whenever a protected page sent the visitor to /login in
// the first place — see the ~40+ `/login?callbackUrl=...` redirects across
// src/app) always wins over the default, matching the pre-existing behavior
// this replaces.
export function getPostLoginRedirect(
  session: { isAttendeeOrg?: boolean } | null | undefined,
  callbackUrl?: string | null
): string {
  if (callbackUrl) return callbackUrl;
  const isAttendeeOrg = session?.isAttendeeOrg ?? true;
  return isAttendeeOrg ? "/events" : "/dashboard";
}
