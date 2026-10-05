import { describe, expect, it } from "vitest";
import { resolveAttendeeRedirect } from "@/lib/attendee-access";

describe("resolveAttendeeRedirect", () => {
  it("sends an attendee-flagged account away from every /dashboard sub-page to /events", () => {
    const session = { isAttendeeOrg: true };
    for (const path of ["/dashboard/events", "/dashboard/events/e1", "/dashboard/team", "/dashboard/settlements"]) {
      expect(resolveAttendeeRedirect(session, path)).toBe("/events");
    }
  });

  it("sends an attendee-flagged account away from /scan routes to /events", () => {
    const session = { isAttendeeOrg: true };
    expect(resolveAttendeeRedirect(session, "/scan/e1")).toBe("/events");
    expect(resolveAttendeeRedirect(session, "/scan/e1/wallet")).toBe("/events");
  });

  it("leaves bare /dashboard alone — it shows its own friendly message instead", () => {
    const session = { isAttendeeOrg: true };
    expect(resolveAttendeeRedirect(session, "/dashboard")).toBeNull();
  });

  it("leaves an organiser-flagged account's navigation untouched", () => {
    const session = { isAttendeeOrg: false };
    expect(resolveAttendeeRedirect(session, "/dashboard/events")).toBeNull();
    expect(resolveAttendeeRedirect(session, "/scan/e1")).toBeNull();
  });

  it("leaves an unauthenticated request untouched (no session to flag)", () => {
    expect(resolveAttendeeRedirect(null, "/dashboard/events")).toBeNull();
    expect(resolveAttendeeRedirect(undefined, "/scan/e1")).toBeNull();
  });

  it("leaves ordinary attendee-safe navigation untouched", () => {
    const session = { isAttendeeOrg: true };
    expect(resolveAttendeeRedirect(session, "/events")).toBeNull();
    expect(resolveAttendeeRedirect(session, "/events/some-event")).toBeNull();
    expect(resolveAttendeeRedirect(session, "/account")).toBeNull();
  });
});
