import { describe, expect, it } from "vitest";
import { getPostSignupRedirect, getPostLoginRedirect } from "@/lib/auth-redirect";

describe("getPostSignupRedirect", () => {
  it("sends an attendee signup to /events", () => {
    expect(getPostSignupRedirect("ATTENDEE")).toBe("/events");
  });

  it("sends an organiser signup to /dashboard/events/new", () => {
    expect(getPostSignupRedirect("ORGANISER")).toBe("/dashboard/events/new");
  });
});

describe("getPostLoginRedirect", () => {
  it("sends an attendee-flagged account to /events", () => {
    expect(getPostLoginRedirect({ isAttendeeOrg: true }, null)).toBe("/events");
  });

  it("sends an organiser-flagged account to /dashboard", () => {
    expect(getPostLoginRedirect({ isAttendeeOrg: false }, null)).toBe("/dashboard");
  });

  it("respects callbackUrl over the account's default destination, either direction", () => {
    expect(getPostLoginRedirect({ isAttendeeOrg: true }, "/dashboard/events/42")).toBe("/dashboard/events/42");
    expect(getPostLoginRedirect({ isAttendeeOrg: false }, "/events/some-event")).toBe("/events/some-event");
  });

  it("treats an empty-string callbackUrl (no real callback) as absent", () => {
    expect(getPostLoginRedirect({ isAttendeeOrg: false }, "")).toBe("/dashboard");
  });

  it("defaults to the attendee destination when the session is missing or has no isAttendeeOrg", () => {
    expect(getPostLoginRedirect(null, null)).toBe("/events");
    expect(getPostLoginRedirect(undefined, null)).toBe("/events");
    expect(getPostLoginRedirect({}, null)).toBe("/events");
  });
});
