import { describe, expect, it } from "vitest";
import { resolveVendorRedirect } from "@/lib/vendor-access";

describe("resolveVendorRedirect", () => {
  it("sends a VENDOR session away from every organiser/admin route to its own dashboard", () => {
    const session = { role: "VENDOR", vendorId: "v1" };
    for (const path of ["/dashboard", "/dashboard/events/e1", "/admin", "/scan/e1", "/scan/e1/wallet", "/account"]) {
      expect(resolveVendorRedirect(session, path)).toBe("/vendor/v1/dashboard");
    }
  });

  it("lets a VENDOR session through on its own portal paths", () => {
    const session = { role: "VENDOR", vendorId: "v1" };
    expect(resolveVendorRedirect(session, "/vendor/v1/dashboard")).toBeNull();
    expect(resolveVendorRedirect(session, "/vendor/login")).toBeNull();
  });

  it("blocks an organiser/staff session from a vendor's dashboard", () => {
    const session = { role: "USER" };
    expect(resolveVendorRedirect(session, "/vendor/v1/dashboard")).toBe("/vendor/login");
  });

  it("blocks an unauthenticated request from a vendor's dashboard", () => {
    expect(resolveVendorRedirect(null, "/vendor/v1/dashboard")).toBe("/vendor/login");
    expect(resolveVendorRedirect(undefined, "/vendor/v1/dashboard")).toBe("/vendor/login");
  });

  it("blocks one vendor session from a DIFFERENT vendor's dashboard", () => {
    const session = { role: "VENDOR", vendorId: "v1" };
    expect(resolveVendorRedirect(session, "/vendor/v2/dashboard")).toBe("/vendor/login");
  });

  it("leaves ordinary buyer/organiser navigation untouched", () => {
    const session = { role: "USER" };
    expect(resolveVendorRedirect(session, "/dashboard")).toBeNull();
    expect(resolveVendorRedirect(session, "/events/some-event")).toBeNull();
    expect(resolveVendorRedirect(null, "/")).toBeNull();
  });
});
