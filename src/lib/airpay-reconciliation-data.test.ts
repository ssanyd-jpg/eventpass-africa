import { describe, expect, it } from "vitest";
import { canAccessAirpayReconciliation, buildAirpayReconciliationCsv } from "@/lib/airpay-reconciliation-data";

describe("canAccessAirpayReconciliation", () => {
  it("allows OWNER", () => {
    expect(canAccessAirpayReconciliation("OWNER")).toBe(true);
  });

  // Financial data — stricter than every sibling report (forecast, cash
  // reconciliation), which only block GATE_CREW. STAFF is blocked here too.
  it("blocks STAFF", () => {
    expect(canAccessAirpayReconciliation("STAFF")).toBe(false);
  });

  it("blocks GATE_CREW", () => {
    expect(canAccessAirpayReconciliation("GATE_CREW")).toBe(false);
  });

  it("blocks an undefined role", () => {
    expect(canAccessAirpayReconciliation(undefined)).toBe(false);
  });
});

describe("buildAirpayReconciliationCsv", () => {
  it("includes the AirPay Reference column header and one row per transaction", () => {
    const csv = buildAirpayReconciliationCsv("Test Fest", [
      {
        createdAt: new Date("2026-09-16T10:00:00Z"),
        amountCents: 15_000,
        mobileNetwork: "MPESA",
        airpayRef: "AP-REF-123",
        identifier: "WALLET-00042",
        source: "TOPUP",
      },
      {
        createdAt: new Date("2026-09-16T11:00:00Z"),
        amountCents: 8_000,
        mobileNetwork: null,
        airpayRef: null,
        identifier: "WALLET-00099",
        source: "TOPUP",
      },
    ]);

    expect(csv).toContain("AirPay reconciliation — Test Fest");
    expect(csv).toContain("Time,Type,Wallet Code / Phone,Amount (Major Units),Payment Method,AirPay Reference");
    expect(csv).toContain("2026-09-16T10:00:00.000Z,Top-up,WALLET-00042,150,M-Pesa,AP-REF-123");
    // Missing airpayRef renders as an empty field, not a literal "null".
    expect(csv).toContain("2026-09-16T11:00:00.000Z,Top-up,WALLET-00099,80,Unknown,");
  });

  // Session 28 — a Direct Sale row unions into the same CSV, tagged so it's
  // distinguishable from a wallet top-up in the same ledger.
  it("tags a Direct Sale row distinctly from a Top-up row", () => {
    const csv = buildAirpayReconciliationCsv("Test Fest", [
      {
        createdAt: new Date("2026-09-16T12:00:00Z"),
        amountCents: 5_000,
        mobileNetwork: "AIRTEL",
        airpayRef: "AP-REF-999",
        identifier: "+255700000123",
        source: "DIRECT_SALE",
      },
    ]);

    expect(csv).toContain("2026-09-16T12:00:00.000Z,Direct Sale,+255700000123,50,Airtel Money,AP-REF-999");
  });
});
