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
import { getSponsorDashboardData } from "@/lib/sponsor-dashboard-data";

let seq = 0;
const uid = (p: string) => `${p}-${Date.now()}-${++seq}`;

async function newOrganizer() {
  const user = await createTestUser();
  const organization = await createTestOrganization();
  await addMembership(organization.id, user.id, "OWNER");
  return { user, organizationId: organization.id };
}

async function tapAt(walletId: string, sponsorId: string, createdAt: Date, campaignId: string | null = null) {
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

describe("getSponsorDashboardData", () => {
  it("only reflects the requested sponsor's own taps, never another sponsor's on the same event", async () => {
    const { user: buyer, organizationId } = await newOrganizer();
    const event = await createTestEvent(organizationId);
    const wallet = await createTestWallet(event.id, buyer.id);

    const sponsorA = await createTestSponsor(event.id, { name: "Sponsor A" });
    const sponsorB = await createTestSponsor(event.id, { name: "Sponsor B" });

    await handleSponsorTap(buyer.id, organizationId, {
      clientId: uid("tap-a"),
      walletCode: wallet.code,
      sponsorId: sponsorA.id,
      eventId: event.id,
    });
    await handleSponsorTap(buyer.id, organizationId, {
      clientId: uid("tap-b1"),
      walletCode: wallet.code,
      sponsorId: sponsorB.id,
      eventId: event.id,
    });
    await handleSponsorTap(buyer.id, organizationId, {
      clientId: uid("tap-b2"),
      walletCode: wallet.code,
      sponsorId: sponsorB.id,
      eventId: event.id,
    });

    const dataA = await getSponsorDashboardData(sponsorA.id);
    expect(dataA).not.toBeNull();
    expect(dataA!.sponsorName).toBe("Sponsor A");
    expect(dataA!.stats.totalTapsToday).toBe(1);

    const dataB = await getSponsorDashboardData(sponsorB.id);
    expect(dataB!.sponsorName).toBe("Sponsor B");
    expect(dataB!.stats.totalTapsToday).toBe(2);
  });

  it("computes average dwell time only across attendees who tapped more than once today", async () => {
    const { user: buyer, organizationId } = await newOrganizer();
    const event = await createTestEvent(organizationId);
    const sponsor = await createTestSponsor(event.id);
    const walletMulti = await createTestWallet(event.id, buyer.id);
    const buyer2 = await createTestUser();
    const walletSingle = await createTestWallet(event.id, buyer2.id);

    const now = new Date();
    const tenMinAgo = new Date(now.getTime() - 10 * 60 * 1000);
    await tapAt(walletMulti.id, sponsor.id, tenMinAgo);
    await tapAt(walletMulti.id, sponsor.id, now);
    await tapAt(walletSingle.id, sponsor.id, now);

    const data = await getSponsorDashboardData(sponsor.id, now);
    expect(data!.stats.totalTapsToday).toBe(3);
    expect(data!.stats.uniqueAttendeesToday).toBe(2);
    // Only walletMulti had 2+ taps — its 10-minute span is the whole average.
    expect(data!.stats.averageDwellMinutes).toBe(10);
  });

  it("returns null dwell time when no attendee tapped more than once", async () => {
    const { user: buyer, organizationId } = await newOrganizer();
    const event = await createTestEvent(organizationId);
    const sponsor = await createTestSponsor(event.id);
    const wallet = await createTestWallet(event.id, buyer.id);

    await tapAt(wallet.id, sponsor.id, new Date());

    const data = await getSponsorDashboardData(sponsor.id);
    expect(data!.stats.averageDwellMinutes).toBeNull();
  });

  it("computes cost per visit from ALL-TIME unique attendees, not just today's", async () => {
    const { user: buyer, organizationId } = await newOrganizer();
    const event = await createTestEvent(organizationId);
    const sponsor = await createTestSponsor(event.id, { feeCents: 100_000 });
    const walletOld = await createTestWallet(event.id, buyer.id);
    const buyer2 = await createTestUser();
    const walletToday = await createTestWallet(event.id, buyer2.id);

    const now = new Date();
    const yesterday = new Date(now.getTime() - 25 * 60 * 60 * 1000);
    await tapAt(walletOld.id, sponsor.id, yesterday);
    await tapAt(walletToday.id, sponsor.id, now);

    const data = await getSponsorDashboardData(sponsor.id, now);
    // Today-only stat sees just the one attendee who tapped today...
    expect(data!.stats.uniqueAttendeesToday).toBe(1);
    // ...but cost-per-visit divides by BOTH attendees across the event's
    // whole life, since the sponsorship fee is a one-time cost, not daily.
    expect(data!.stats.costPerVisitCents).toBe(50_000);
  });

  it("returns null cost-per-visit when nobody has ever tapped", async () => {
    const { organizationId } = await newOrganizer();
    const event = await createTestEvent(organizationId);
    const sponsor = await createTestSponsor(event.id, { feeCents: 50_000 });

    const data = await getSponsorDashboardData(sponsor.id);
    expect(data!.stats.costPerVisitCents).toBeNull();
  });

  it("breaks down redemptions per campaign using each campaign's own running total", async () => {
    const { organizationId } = await newOrganizer();
    const event = await createTestEvent(organizationId);
    const sponsor = await createTestSponsor(event.id);
    await createTestSponsorCampaign(sponsor.id, { name: "Free Sample", redemptionCount: 12 });
    await createTestSponsorCampaign(sponsor.id, { name: "Raffle Entry", redemptionCount: 3 });

    const data = await getSponsorDashboardData(sponsor.id);
    const byName = Object.fromEntries(data!.campaignBreakdown.map((c) => [c.name, c.redemptions]));
    expect(byName["Free Sample"]).toBe(12);
    expect(byName["Raffle Entry"]).toBe(3);
  });

  it("returns null for a sponsor id that doesn't exist", async () => {
    const data = await getSponsorDashboardData("nonexistent-sponsor-id");
    expect(data).toBeNull();
  });
});
