// Where a brand-new signup lands right after account creation — pulled out
// as its own pure function (rather than an inline ternary in
// src/app/register/page.tsx) so the mapping itself is unit-testable without
// a browser/jsdom harness, consistent with this codebase's convention of
// keeping deterministic logic in src/lib and UI components thin.
export type AccountType = "ATTENDEE" | "ORGANISER";

export function getPostSignupRedirect(accountType: AccountType): string {
  return accountType === "ATTENDEE" ? "/events" : "/dashboard/events/new";
}
