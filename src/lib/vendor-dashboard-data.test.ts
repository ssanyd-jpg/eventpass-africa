import { describe, expect, it } from "vitest";
import { prisma } from "@/lib/prisma";
import {
  createTestUser,
  createTestOrganization,
  addMembership,
  createTestEvent,
  createTestVendor,
  createTestWallet,
} from "@/lib/test-fixtures";
import { handleChargeWallet, handleSellTickets, handleCaptureExhibitorLead } from "@/lib/sync-handlers";
import { getVendorDashboardData, getExhibitorLeadsExportData, buildExhibitorLeadsCsv } from "@/lib/vendor-dashboard-data";

async function newOrganizer() {
  const user = await createTestUser();
  const organization = await createTestOrganization();
  await addMembership(organization.id, user.id, "OWNER");
  return { user, organizationId: organization.id };
}

describe("getVendorDashboardData", () => {
  it("only reflects the requested vendor's own sales, never another vendor's on the same event", async () => {
    const { organizationId } = await newOrganizer();
    const event = await createTestEvent(organizationId);
    const buyer = await createTestUser();
    const wallet = await createTestWallet(event.id, buyer.id, { balanceCents: 100000 });

    const vendorA = await createTestVendor(event.id, { name: "Vendor A" });
    const vendorB = await createTestVendor(event.id, { name: "Vendor B" });

    await handleChargeWallet(buyer.id, organizationId, {
      clientId: `chg-a-${Date.now()}`,
      walletCode: wallet.code,
      vendorId: vendorA.id,
      eventId: event.id,
      amountCents: 5000,
      item: "Vendor A special",
    });
    await handleChargeWallet(buyer.id, organizationId, {
      clientId: `chg-b-${Date.now()}`,
      walletCode: wallet.code,
      vendorId: vendorB.id,
      eventId: event.id,
      amountCents: 9000,
      item: "Vendor B special",
    });

    const dataA = await getVendorDashboardData(vendorA.id);
    expect(dataA).not.toBeNull();
    expect(dataA!.vendorName).toBe("Vendor A");
    expect(dataA!.stats.todaysSalesTotalCents).toBe(5000);
    expect(dataA!.stats.transactionCount).toBe(1);
    expect(dataA!.transactions).toHaveLength(1);
    expect(dataA!.transactions[0].item).toBe("Vendor A special");
    expect(dataA!.topItems.map((t) => t.item)).toEqual(["Vendor A special"]);
    // Vendor B's data must never leak into vendor A's response.
    expect(dataA!.stats.todaysSalesTotalCents).not.toBe(14000);
    expect(JSON.stringify(dataA)).not.toContain("Vendor B special");

    const dataB = await getVendorDashboardData(vendorB.id);
    expect(dataB!.vendorName).toBe("Vendor B");
    expect(dataB!.stats.todaysSalesTotalCents).toBe(9000);
    expect(JSON.stringify(dataB)).not.toContain("Vendor A special");
  });

  it("returns null for a vendor id that doesn't exist", async () => {
    const data = await getVendorDashboardData("nonexistent-vendor-id");
    expect(data).toBeNull();
  });
});

// Session 19 — CONFERENCE exhibitor lead capture, surfaced on the vendor
// portal's own dashboard ("My leads").
async function setupExhibitor() {
  const { user: owner, organizationId } = await newOrganizer();
  const event = await createTestEvent(organizationId, [{ priceCents: 500_000, quantityTotal: 200 }]);
  await prisma.event.update({ where: { id: event.id }, data: { eventType: "CONFERENCE" } });

  const attendee = await createTestUser({ name: "Amina Attendee" });
  await handleSellTickets(attendee.id, {
    clientId: `order-${Date.now()}-${Math.random()}`,
    eventId: event.id,
    items: [{ ticketTypeId: event.ticketTypes[0].id, quantity: 1, codes: [`TIX-${Date.now()}-${Math.random()}`] }],
  });
  const ticket = await prisma.ticket.findFirstOrThrow({ where: { eventId: event.id, order: { userId: attendee.id } } });
  const credential = await prisma.credential.create({
    data: {
      organizationId,
      ticketId: ticket.id,
      code: ticket.code,
      nfcUid: `nfc-${Date.now()}-${Math.random()}`.toUpperCase(),
      status: "ACTIVE",
      createdByUserId: owner.id,
      createdByName: owner.name,
    },
  });

  const vendor = await createTestVendor(event.id, { name: "Acme Exhibit" });
  return { organizationId, event, vendor, credential };
}

describe("getVendorDashboardData — My leads (Session 19)", () => {
  it("includes this exhibitor's captured leads with their notes", async () => {
    const { organizationId, event, vendor, credential } = await setupExhibitor();
    await handleCaptureExhibitorLead(organizationId, {
      clientId: `lead-${Date.now()}`,
      eventId: event.id,
      vendorId: vendor.id,
      nfcUid: credential.nfcUid,
      notes: "Follow up next week",
    });

    const data = await getVendorDashboardData(vendor.id);
    expect(data!.eventType).toBe("CONFERENCE");
    expect(data!.leads).toHaveLength(1);
    expect(data!.leads[0].attendeeName).toBe("Amina Attendee");
    expect(data!.leads[0].notes).toBe("Follow up next week");
  });

  // Neon cold-start/latency headroom, same reasoning timing.test.ts's own
  // heavier tests document — this chains setupExhibitor plus a second
  // vendor plus two handler calls.
  it("an exhibitor can only see their own leads, never another exhibitor's", { timeout: 120000 }, async () => {
    const { organizationId, event, vendor: vendorA, credential } = await setupExhibitor();
    const vendorB = await createTestVendor(event.id, { name: "Globex Booth" });

    await handleCaptureExhibitorLead(organizationId, {
      clientId: `lead-a-${Date.now()}`,
      eventId: event.id,
      vendorId: vendorA.id,
      nfcUid: credential.nfcUid,
      notes: "For vendor A only",
    });
    await handleCaptureExhibitorLead(organizationId, {
      clientId: `lead-b-${Date.now()}`,
      eventId: event.id,
      vendorId: vendorB.id,
      nfcUid: credential.nfcUid,
      notes: "For vendor B only",
    });

    const dataA = await getVendorDashboardData(vendorA.id);
    expect(dataA!.leads).toHaveLength(1);
    expect(dataA!.leads[0].notes).toBe("For vendor A only");
    expect(JSON.stringify(dataA)).not.toContain("For vendor B only");

    const dataB = await getVendorDashboardData(vendorB.id);
    expect(dataB!.leads).toHaveLength(1);
    expect(dataB!.leads[0].notes).toBe("For vendor B only");
    expect(JSON.stringify(dataB)).not.toContain("For vendor A only");
  });
});

describe("buildExhibitorLeadsCsv / getExhibitorLeadsExportData", () => {
  it("exports headers and rows including a null-note lead as an empty field", () => {
    const csv = buildExhibitorLeadsCsv("Acme Exhibit", [
      { capturedAt: new Date("2026-06-01T10:00:00Z").toISOString(), attendeeName: "Amina Attendee", notes: "Follow up" },
      { capturedAt: new Date("2026-06-01T11:00:00Z").toISOString(), attendeeName: "No Notes Guy", notes: null },
    ]);
    expect(csv).toContain("Time,Attendee,Notes");
    expect(csv).toContain("Amina Attendee");
    expect(csv).toContain("Follow up");
    expect(csv).toContain("No Notes Guy");
  });

  it("scopes export data to only the requested vendor's leads", async () => {
    const { organizationId, event, vendor, credential } = await setupExhibitor();
    await handleCaptureExhibitorLead(organizationId, {
      clientId: `lead-${Date.now()}`,
      eventId: event.id,
      vendorId: vendor.id,
      nfcUid: credential.nfcUid,
      notes: "Export me",
    });

    const data = await getExhibitorLeadsExportData(vendor.id);
    expect(data!.vendorName).toBe("Acme Exhibit");
    expect(data!.rows).toHaveLength(1);
    expect(data!.rows[0].notes).toBe("Export me");
  });
});
