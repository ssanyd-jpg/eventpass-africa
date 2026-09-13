import { describe, expect, it } from "vitest";
import { compareCampaigns, timeToRedeem, type CampaignInput, type CampaignTapRecord } from "@/lib/sponsor-campaign-analytics";

const CAMPAIGN_A: CampaignInput = { id: "camp-a", name: "Free Sample", code: "SAMPLE" };
const CAMPAIGN_B: CampaignInput = { id: "camp-b", name: "Scan For Prize", code: "PRIZE" };

function tap(walletId: string, campaignId: string | null, createdAt: Date): CampaignTapRecord {
  return { walletId, campaignId, createdAt };
}

describe("compareCampaigns", () => {
  it("picks the campaign with the higher redemption rate as the winner", () => {
    const now = new Date();
    const taps = [
      // 4 unique zone visitors total.
      tap("w1", "camp-a", now),
      tap("w2", "camp-a", now),
      tap("w3", "camp-b", now),
      tap("w4", null, now), // plain zone tap, no redemption
    ];

    const stats = compareCampaigns([CAMPAIGN_A, CAMPAIGN_B], taps);
    const a = stats.find((s) => s.id === "camp-a")!;
    const b = stats.find((s) => s.id === "camp-b")!;

    expect(a.redemptionRate).toBeCloseTo(0.5); // 2/4
    expect(b.redemptionRate).toBeCloseTo(0.25); // 1/4
    expect(a.isWinner).toBe(true);
    expect(b.isWinner).toBe(false);
    expect(a.relativePerformance).toBe(1);
    expect(b.relativePerformance).toBeCloseTo(0.5);
  });

  it("gives every campaign a zero redemption rate when the zone has zero visitors", () => {
    const stats = compareCampaigns([CAMPAIGN_A, CAMPAIGN_B], []);
    expect(stats.map((s) => s.redemptionRate)).toEqual([0, 0]);
    expect(stats.every((s) => !s.isWinner)).toBe(true);
  });

  it("gives a redemption rate of exactly 1 when every zone visitor redeemed", () => {
    const now = new Date();
    const taps = [tap("w1", "camp-a", now), tap("w2", "camp-a", now)];
    const stats = compareCampaigns([CAMPAIGN_A], taps);
    expect(stats[0].redemptionRate).toBe(1);
    expect(stats[0].isWinner).toBe(true);
  });

  it("marks a real partial (neither zero nor full) redemption rate correctly", () => {
    const now = new Date();
    const taps = [tap("w1", "camp-a", now), tap("w2", null, now), tap("w3", null, now)];
    const stats = compareCampaigns([CAMPAIGN_A], taps);
    expect(stats[0].redemptionRate).toBeCloseTo(1 / 3);
  });

  it("marks BOTH campaigns as winners on an exact tie", () => {
    const now = new Date();
    const taps = [tap("w1", "camp-a", now), tap("w2", "camp-b", now)];
    const stats = compareCampaigns([CAMPAIGN_A, CAMPAIGN_B], taps);
    expect(stats.every((s) => s.isWinner)).toBe(true);
    expect(stats.every((s) => s.relativePerformance === 1)).toBe(true);
  });

  it("counts total redemptions and unique redeemers separately", () => {
    const now = new Date();
    // w1 redeems camp-a twice (shouldn't happen in practice given the
    // schema's own @@unique([campaignId, walletId]), but the pure function
    // itself should still count total vs unique distinctly).
    const taps = [
      tap("w1", "camp-a", now),
      tap("w1", "camp-a", new Date(now.getTime() + 60000)),
      tap("w2", "camp-a", now),
    ];
    const stats = compareCampaigns([CAMPAIGN_A], taps);
    expect(stats[0].totalRedemptions).toBe(3);
    expect(stats[0].uniqueRedeemers).toBe(2);
  });
});

describe("timeToRedeem", () => {
  it("averages minutes between an attendee's first zone tap and their campaign redemption", () => {
    const base = new Date("2026-01-01T10:00:00Z");
    const taps = [
      // w1: arrives at 10:00, redeems camp-a at 10:15 -> 15 minutes.
      tap("w1", null, base),
      tap("w1", "camp-a", new Date(base.getTime() + 15 * 60000)),
      // w2: arrives at 10:00, redeems camp-a at 10:25 -> 25 minutes.
      tap("w2", null, base),
      tap("w2", "camp-a", new Date(base.getTime() + 25 * 60000)),
    ];
    expect(timeToRedeem(taps, "camp-a")).toBe(20); // average of 15 and 25
  });

  it("counts 0 minutes when an attendee's only tap was the redemption itself", () => {
    const base = new Date("2026-01-01T10:00:00Z");
    const taps = [tap("w1", "camp-a", base)];
    expect(timeToRedeem(taps, "camp-a")).toBe(0);
  });

  it("returns null when nobody has redeemed this campaign", () => {
    const base = new Date("2026-01-01T10:00:00Z");
    const taps = [tap("w1", null, base), tap("w2", "camp-b", base)];
    expect(timeToRedeem(taps, "camp-a")).toBeNull();
  });

  it("ignores a later, unrelated tap when computing an attendee's arrival time", () => {
    const base = new Date("2026-01-01T10:00:00Z");
    const taps = [
      tap("w1", "camp-a", new Date(base.getTime() + 10 * 60000)), // redeems at +10m
      tap("w1", null, base), // but actually arrived at +0m (out of order in the array)
    ];
    expect(timeToRedeem(taps, "camp-a")).toBe(10);
  });
});
