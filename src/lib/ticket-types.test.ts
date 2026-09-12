import { describe, expect, it } from "vitest";
import { isFastTrackTicketType, resolveGateSignal } from "@/lib/ticket-types";

describe("isFastTrackTicketType", () => {
  it("is true for a VIP ticket type by name, case-insensitive", () => {
    expect(isFastTrackTicketType("VIP", false)).toBe(true);
    expect(isFastTrackTicketType("vip pass", false)).toBe(true);
    expect(isFastTrackTicketType("Backstage VIP Experience", false)).toBe(true);
  });

  it("is true when isFastTrack is set, regardless of name", () => {
    expect(isFastTrackTicketType("General Admission", true)).toBe(true);
  });

  it("is false for a standard ticket type with neither signal", () => {
    expect(isFastTrackTicketType("General Admission", false)).toBe(false);
    expect(isFastTrackTicketType("Early Bird", false)).toBe(false);
  });
});

describe("resolveGateSignal", () => {
  it("signals vip for a VIP-by-name ticket type not yet checked in", () => {
    expect(resolveGateSignal({ checkedIn: false, ticketTypeName: "VIP", isFastTrack: false })).toBe("vip");
  });

  it("signals vip for an isFastTrack-flagged ticket type not yet checked in", () => {
    expect(resolveGateSignal({ checkedIn: false, ticketTypeName: "General Admission", isFastTrack: true })).toBe("vip");
  });

  it("signals standard for a plain ticket type not yet checked in", () => {
    expect(resolveGateSignal({ checkedIn: false, ticketTypeName: "General Admission", isFastTrack: false })).toBe("standard");
  });

  it("signals already for a checked-in ticket regardless of VIP status", () => {
    expect(resolveGateSignal({ checkedIn: true, ticketTypeName: "VIP", isFastTrack: true })).toBe("already");
    expect(resolveGateSignal({ checkedIn: true, ticketTypeName: "General Admission", isFastTrack: false })).toBe("already");
  });
});
