import { describe, expect, it } from "vitest";
import { getPostSignupRedirect } from "@/lib/auth-redirect";

describe("getPostSignupRedirect", () => {
  it("sends an attendee signup to /events", () => {
    expect(getPostSignupRedirect("ATTENDEE")).toBe("/events");
  });

  it("sends an organiser signup to /dashboard/events/new", () => {
    expect(getPostSignupRedirect("ORGANISER")).toBe("/dashboard/events/new");
  });
});
