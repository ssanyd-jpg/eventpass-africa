import { describe, expect, it } from "vitest";
import { resolveSponsorRedirect } from "@/lib/sponsor-access";

describe("resolveSponsorRedirect", () => {
  it("sends a SPONSOR session away from every organiser/admin/vendor route to its own dashboard", () => {
    const session = { role: "SPONSOR", sponsorId: "s1" };
    for (const path of [
      "/dashboard",
      "/dashboard/events/e1",
      "/admin",
      "/scan/e1",
      "/scan/e1/wallet",
      "/account",
      "/vendor",
      "/vendor/v1/dashboard",
    ]) {
      expect(resolveSponsorRedirect(session, path)).toBe("/sponsor/s1/dashboard");
    }
  });

  it("lets a SPONSOR session through on its own portal paths", () => {
    const session = { role: "SPONSOR", sponsorId: "s1" };
    expect(resolveSponsorRedirect(session, "/sponsor/s1/dashboard")).toBeNull();
    expect(resolveSponsorRedirect(session, "/sponsor/login")).toBeNull();
  });

  it("blocks an organiser/staff session from a sponsor's dashboard", () => {
    const session = { role: "USER" };
    expect(resolveSponsorRedirect(session, "/sponsor/s1/dashboard")).toBe("/sponsor/login");
  });

  it("blocks a VENDOR session from a sponsor's dashboard", () => {
    const session = { role: "VENDOR" };
    expect(resolveSponsorRedirect(session, "/sponsor/s1/dashboard")).toBe("/sponsor/login");
  });

  it("blocks an unauthenticated request from a sponsor's dashboard", () => {
    expect(resolveSponsorRedirect(null, "/sponsor/s1/dashboard")).toBe("/sponsor/login");
    expect(resolveSponsorRedirect(undefined, "/sponsor/s1/dashboard")).toBe("/sponsor/login");
  });

  it("blocks one sponsor session from a DIFFERENT sponsor's dashboard", () => {
    const session = { role: "SPONSOR", sponsorId: "s1" };
    expect(resolveSponsorRedirect(session, "/sponsor/s2/dashboard")).toBe("/sponsor/login");
  });

  it("leaves ordinary buyer/organiser navigation untouched", () => {
    const session = { role: "USER" };
    expect(resolveSponsorRedirect(session, "/dashboard")).toBeNull();
    expect(resolveSponsorRedirect(session, "/events/some-event")).toBeNull();
    expect(resolveSponsorRedirect(null, "/")).toBeNull();
  });
});
