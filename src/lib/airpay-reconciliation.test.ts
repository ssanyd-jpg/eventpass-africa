import { describe, expect, it } from "vitest";
import {
  summarizeAirpayReconciliation,
  computeSettlementVariance,
  labelForMethod,
  type TopupRecord,
} from "@/lib/airpay-reconciliation";

function topup(overrides: Partial<TopupRecord> = {}): TopupRecord {
  return {
    walletCode: "•••0001",
    amountCents: 10_000,
    mobileNetwork: "MPESA",
    airpayRef: "AP-REF-1",
    createdAt: new Date("2026-09-16T10:00:00Z"),
    ...overrides,
  };
}

describe("summarizeAirpayReconciliation — payment method breakdown", () => {
  it("totals count, amount, and % of volume correctly per method", () => {
    const topups = [
      topup({ mobileNetwork: "MPESA", amountCents: 30_000 }),
      topup({ mobileNetwork: "MPESA", amountCents: 20_000 }),
      topup({ mobileNetwork: "AIRTEL", amountCents: 50_000 }),
    ];
    const summary = summarizeAirpayReconciliation("TZS", topups);

    const mpesa = summary.methodBreakdown.find((r) => r.method === "MPESA")!;
    expect(mpesa.count).toBe(2);
    expect(mpesa.amountCents).toBe(50_000);
    expect(mpesa.percentOfVolume).toBeCloseTo(50);

    const airtel = summary.methodBreakdown.find((r) => r.method === "AIRTEL")!;
    expect(airtel.count).toBe(1);
    expect(airtel.amountCents).toBe(50_000);
    expect(airtel.percentOfVolume).toBeCloseTo(50);

    expect(summary.methodBreakdown.reduce((s, r) => s + r.amountCents, 0)).toBe(summary.totalAmountCents);
  });

  it("buckets a null or unrecognized network as Unknown", () => {
    const topups = [
      topup({ mobileNetwork: null }),
      topup({ mobileNetwork: "SOME_FUTURE_NETWORK" }),
      topup({ mobileNetwork: "TIGO" }),
    ];
    const summary = summarizeAirpayReconciliation("TZS", topups);

    const unknown = summary.methodBreakdown.find((r) => r.method === "UNKNOWN")!;
    expect(unknown.count).toBe(2);
    expect(unknown.label).toBe("Unknown");
    expect(summary.methodBreakdown.find((r) => r.method === "TIGO")!.label).toBe("Tigo Pesa");
  });

  it("labelForMethod matches the breakdown's own labeling", () => {
    expect(labelForMethod("MPESA")).toBe("M-Pesa");
    expect(labelForMethod("HALOTEL")).toBe("HaloPesa");
    expect(labelForMethod(null)).toBe("Unknown");
    expect(labelForMethod("VISA")).toBe("Unknown"); // not a supported wallet top-up method in this app
  });
});

describe("summarizeAirpayReconciliation — exception detection", () => {
  it("classifies a top-up with no airpayRef as an exception, not matched", () => {
    const topups = [
      topup({ airpayRef: "AP-1", amountCents: 10_000 }),
      topup({ airpayRef: null, amountCents: 4_000 }),
      topup({ airpayRef: "", amountCents: 6_000 }), // empty string is also "missing" for reconciliation purposes
    ];
    const summary = summarizeAirpayReconciliation("TZS", topups);

    expect(summary.matchedCount).toBe(1);
    expect(summary.matchedAmountCents).toBe(10_000);
    expect(summary.exceptionCount).toBe(2);
    expect(summary.exceptionAmountCents).toBe(10_000);
    expect(summary.totalCount).toBe(3);
    expect(summary.totalAmountCents).toBe(20_000);
  });

  it("produces an empty exception list when every top-up has a reference", () => {
    const summary = summarizeAirpayReconciliation("TZS", [topup(), topup()]);
    expect(summary.exceptions).toHaveLength(0);
    expect(summary.exceptionCount).toBe(0);
  });

  it("carries wallet code, amount, and method label through into each exception row", () => {
    const summary = summarizeAirpayReconciliation("TZS", [
      topup({ airpayRef: null, walletCode: "•••9999", amountCents: 7_500, mobileNetwork: "HALOTEL", createdAt: new Date("2026-09-16T11:30:00Z") }),
    ]);
    expect(summary.exceptions[0]).toEqual({
      walletCode: "•••9999",
      amountCents: 7_500,
      method: "HALOTEL",
      label: "HaloPesa",
      createdAt: "2026-09-16T11:30:00.000Z",
    });
  });
});

describe("computeSettlementVariance", () => {
  it("is zero when expected equals matched", () => {
    expect(computeSettlementVariance(100_000, 100_000)).toBe(0);
  });

  it("is positive when expected exceeds matched (unverified volume)", () => {
    expect(computeSettlementVariance(100_000, 60_000)).toBe(40_000);
  });

  it("is negative when matched exceeds expected", () => {
    expect(computeSettlementVariance(60_000, 100_000)).toBe(-40_000);
  });
});

describe("summarizeAirpayReconciliation — variance wiring", () => {
  it("flags a positive variance equal to the exception volume when some top-ups are unmatched", () => {
    const summary = summarizeAirpayReconciliation("TZS", [
      topup({ airpayRef: "AP-1", amountCents: 30_000 }),
      topup({ airpayRef: null, amountCents: 10_000 }),
    ]);
    expect(summary.expectedSettlementCents).toBe(40_000);
    expect(summary.varianceCents).toBe(10_000);
  });

  it("has zero variance when every top-up is matched", () => {
    const summary = summarizeAirpayReconciliation("TZS", [topup({ amountCents: 20_000 }), topup({ amountCents: 5_000 })]);
    expect(summary.varianceCents).toBe(0);
  });

  it("returns all-zero figures for no confirmed top-ups", () => {
    const summary = summarizeAirpayReconciliation("TZS", []);
    expect(summary.totalCount).toBe(0);
    expect(summary.matchedCount).toBe(0);
    expect(summary.exceptionCount).toBe(0);
    expect(summary.varianceCents).toBe(0);
    expect(summary.methodBreakdown).toHaveLength(0);
  });
});
