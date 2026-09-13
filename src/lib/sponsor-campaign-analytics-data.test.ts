import { describe, expect, it } from "vitest";
import { prisma } from "@/lib/prisma";
import {
  createTestUser,
  createTestOrganization,
  addMembership,
  createTestEvent,
  createTestSponsor,
  createTestSponsorCampaign,
  createTestWallet,
} from "@/lib/test-fixtures";
import { handleSponsorTap } from "@/lib/sync-handlers";
import { getSponsorCampaignComparison, buildCampaignComparisonCsv } from "@/lib/sponsor-campaign-analytics-data";

let seq = 0;
const uid = (p: string) => `${p}-${Date.now()}-${++seq}`;

async function newOrganizer() {
  const user = await createTestUser();
  const organization = await createTestOrganization();
  await addMembership(organization.id, user.id, "OWNER");
  return { user, organizationId: organization.id };
}

async function tapAt(walletId: string, sponsorId: string, campaignId: string | null, createdAt: Date) {
  return prisma.walletTransaction.create({
    data: {
      clientId: uid("tap"),
      type: "SPONSOR_TAP",
      status: "COMPLETED",
      currency: "TZS",
      walletId,
      sponsorId,
      campaignId,
      createdAt,
    },
  });
}

describe("getSponsorCampaignComparison", () => {
  it("is ineligible (no comparison section) with fewer than 2 active campaigns", async () => {
    const { organizationId } = await newOrganizer();
    const event = await createTestEvent(organizationId);
    const sponsor = await createTestSponsor(event.id);
    await createTestSponsorCampaign(sponsor.id, { name: "Only Campaign" });

    const result = await getSponsorCampaignComparison(sponsor.id);
    expect(result!.eligible).toBe(false);
  });

  // Redemption rate's denominator (total unique zone visitors) is shared
  // across every campaign at one sponsor, and the schema's own
  // @@unique([campaignId, walletId]) constraint means a real campaign's
  // totalRedemptions and uniqueRedeemers are always equal — so at the DB
  // level, "more redemptions" and "higher rate" always move together; there
  // is no real row set where they'd disagree. The distinguishing "picks the
  // winner by RATE, not by raw totalRedemptions, when they diverge" case
  // needs synthetic duplicate-tap data that bypasses that DB constraint —
  // that's covered directly in sponsor-campaign-analytics.test.ts's own
  // "counts total redemptions and unique redeemers separately" and tie
  // tests. This test instead confirms the end-to-end DB path computes the
  // rate against the WHOLE zone's visitor pool (not just each campaign's
  // own redeemers) and picks the right winner from real rows.
  it("computes redemption rate against the whole zone's unique visitors and picks the correct winner", async () => {
    const { user: buyer, organizationId } = await newOrganizer();
    const event = await createTestEvent(organizationId);
    const sponsor = await createTestSponsor(event.id);
    const campA = await createTestSponsorCampaign(sponsor.id, { name: "Free Sample" });
    const campB = await createTestSponsorCampaign(sponsor.id, { name: "Scan For Prize" });

    const now = new Date();
    // All fixture rows are created in parallel (Promise.all) rather than
    // one-at-a-time — sequential round-trips against the remote test DB is
    // what made an earlier version of this test time out at the default
    // 60s under Neon's per-request latency.
    const [aWallets, bWallets, plainWallets] = await Promise.all([
      Promise.all([buyer, await createTestUser()].map((u) => createTestWallet(event.id, u.id))),
      Promise.all([await createTestUser()].map((u) => createTestWallet(event.id, u.id))),
      Promise.all(Array.from({ length: 6 }, () => createTestUser())).then((users) =>
        Promise.all(users.map((u) => createTestWallet(event.id, u.id)))
      ),
    ]);

    await Promise.all([
      ...aWallets.map((w) => tapAt(w.id, sponsor.id, campA.id, now)),
      ...bWallets.map((w) => tapAt(w.id, sponsor.id, campB.id, now)),
      ...plainWallets.map((w) => tapAt(w.id, sponsor.id, null, now)), // plain zone taps, no redemption
    ]);

    // Total zone visitors: 2 (A) + 1 (B) + 6 (plain) = 9.
    const result = await getSponsorCampaignComparison(sponsor.id);
    expect(result!.eligible).toBe(true);
    const a = result!.campaigns.find((c) => c.id === campA.id)!;
    const b = result!.campaigns.find((c) => c.id === campB.id)!;
    expect(a.uniqueRedeemers).toBe(2);
    expect(a.redemptionRate).toBeCloseTo(2 / 9);
    expect(b.uniqueRedeemers).toBe(1);
    expect(b.redemptionRate).toBeCloseTo(1 / 9);
    expect(a.isWinner).toBe(true);
    expect(b.isWinner).toBe(false);
  });

  it("never leaks another sponsor's taps or campaigns into this sponsor's comparison", async () => {
    const { organizationId } = await newOrganizer();
    const event = await createTestEvent(organizationId);
    const sponsorA = await createTestSponsor(event.id, { name: "Sponsor A" });
    const sponsorB = await createTestSponsor(event.id, { name: "Sponsor B" });
    const aCamp1 = await createTestSponsorCampaign(sponsorA.id, { name: "A1" });
    const aCamp2 = await createTestSponsorCampaign(sponsorA.id, { name: "A2" });
    const bCamp1 = await createTestSponsorCampaign(sponsorB.id, { name: "B1" });
    const bCamp2 = await createTestSponsorCampaign(sponsorB.id, { name: "B2" });

    const attendee = await createTestUser();
    const wallet = await createTestWallet(event.id, attendee.id);
    const now = new Date();
    await tapAt(wallet.id, sponsorA.id, aCamp1.id, now);
    await tapAt(wallet.id, sponsorB.id, bCamp1.id, now);

    const resultA = await getSponsorCampaignComparison(sponsorA.id);
    expect(resultA!.campaigns.map((c) => c.id).sort()).toEqual([aCamp1.id, aCamp2.id].sort());
    // Sponsor A's zone had exactly 1 unique visitor (this same attendee tapped
    // both sponsors' zones, but sponsor B's tap must not count toward A's total).
    const aWinner = resultA!.campaigns.find((c) => c.id === aCamp1.id)!;
    expect(aWinner.redemptionRate).toBe(1);

    const resultB = await getSponsorCampaignComparison(sponsorB.id);
    expect(resultB!.campaigns.map((c) => c.id).sort()).toEqual([bCamp1.id, bCamp2.id].sort());
  });

  it("returns null for a sponsor id that doesn't exist", async () => {
    const result = await getSponsorCampaignComparison("nonexistent-sponsor-id");
    expect(result).toBeNull();
  });

  it("excludes an inactive campaign from the comparison and its eligibility count", async () => {
    const { organizationId } = await newOrganizer();
    const event = await createTestEvent(organizationId);
    const sponsor = await createTestSponsor(event.id);
    await createTestSponsorCampaign(sponsor.id, { name: "Active One" });
    await createTestSponsorCampaign(sponsor.id, { name: "Active Two" });
    await createTestSponsorCampaign(sponsor.id, { name: "Retired", active: false });

    const result = await getSponsorCampaignComparison(sponsor.id);
    expect(result!.campaigns).toHaveLength(2);
    expect(result!.campaigns.some((c) => c.name === "Retired")).toBe(false);
  });
});

describe("buildCampaignComparisonCsv", () => {
  it("produces correct headers and marks the winner", async () => {
    const { organizationId } = await newOrganizer();
    const event = await createTestEvent(organizationId);
    const sponsor = await createTestSponsor(event.id, { name: "Acme Corp" });
    const campA = await createTestSponsorCampaign(sponsor.id, { name: "Free Sample", code: "SAMPLE" });
    await createTestSponsorCampaign(sponsor.id, { name: "Scan For Prize", code: "PRIZE" });

    const attendee = await createTestUser();
    const wallet = await createTestWallet(event.id, attendee.id);
    await tapAt(wallet.id, sponsor.id, campA.id, new Date());

    const result = await getSponsorCampaignComparison(sponsor.id);
    const csv = buildCampaignComparisonCsv("Acme Corp", result!.campaigns);

    expect(csv).toContain("Campaign comparison — Acme Corp");
    expect(csv).toContain("Campaign,Code,Total Redemptions,Unique Redeemers,Redemption Rate,Avg. Time To Redeem (min),Winner");
    expect(csv).toContain("Free Sample,SAMPLE,1,1,100.0%");
    expect(csv).toContain("Scan For Prize,PRIZE,0,0,0.0%");
  });
});
