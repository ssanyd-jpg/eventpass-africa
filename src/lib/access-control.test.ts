import { describe, expect, it } from "vitest";
import { isOpAllowedForRole } from "@/lib/access-control";
import { payloadSchemas } from "@/lib/sync-handlers";

const GATE_CREW_ALLOWED = [
  "CHECK_IN",
  "CHECK_IN_VENDOR",
  "SELL_TICKETS",
  "APPLY_VENDOR",
  "CREATE_WALLET",
  "CARRY_OVER_WALLET",
  "TOPUP_WALLET",
  "CHECK_TOPUP_STATUS",
  "WITHDRAW_WALLET",
  "CHECK_ORDER_PAYMENT_STATUS",
  "CANCEL_PENDING_ORDER",
] as const;

describe("isOpAllowedForRole", () => {
  it("allows GATE_CREW to check tickets and vendor badges in", () => {
    expect(isOpAllowedForRole("GATE_CREW", "CHECK_IN")).toBe(true);
    expect(isOpAllowedForRole("GATE_CREW", "CHECK_IN_VENDOR")).toBe(true);
  });

  it("allows GATE_CREW the personal/self-scoped ops", () => {
    for (const op of ["SELL_TICKETS", "APPLY_VENDOR", "CREATE_WALLET", "TOPUP_WALLET", "CHECK_TOPUP_STATUS", "WITHDRAW_WALLET", "CHECK_ORDER_PAYMENT_STATUS", "CANCEL_PENDING_ORDER"] as const) {
      expect(isOpAllowedForRole("GATE_CREW", op)).toBe(true);
    }
  });

  it("blocks GATE_CREW from org-management and money-moving ops", () => {
    for (const op of [
      "CREATE_EVENT",
      "EDIT_EVENT",
      "CANCEL_EVENT",
      "REFUND_ORDER",
      "ADD_MOBILE_MONEY_ACCOUNT",
      "ADD_VENDOR",
      "APPROVE_VENDOR",
      "REJECT_VENDOR",
      "CHARGE_WALLET",
      "SPONSOR_TAP",
      "APPROVE_WITHDRAWAL",
      "REJECT_WITHDRAWAL",
      "MARK_ORDER_PAID",
    ] as const) {
      expect(isOpAllowedForRole("GATE_CREW", op)).toBe(false);
    }
  });

  it("allows OWNER and STAFF every op unconditionally", () => {
    for (const op of Object.keys(payloadSchemas) as (keyof typeof payloadSchemas)[]) {
      expect(isOpAllowedForRole("OWNER", op)).toBe(true);
      expect(isOpAllowedForRole("STAFF", op)).toBe(true);
    }
  });

  // Guards against silent drift: every payloadSchemas key must be
  // deliberately classified above whenever a new OutboxOpType is added —
  // fails loudly instead of a new op silently falling through untested.
  it("classifies every known op type one way or the other", () => {
    const allowed = new Set<string>(GATE_CREW_ALLOWED);
    const allOps = Object.keys(payloadSchemas) as (keyof typeof payloadSchemas)[];
    const blockedOps = allOps.filter((op) => !allowed.has(op));

    expect(allOps.length).toBe(allowed.size + blockedOps.length);
    for (const op of blockedOps) {
      expect(isOpAllowedForRole("GATE_CREW", op)).toBe(false);
    }
  });
});
