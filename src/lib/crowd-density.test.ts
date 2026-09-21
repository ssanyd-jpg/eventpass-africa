import { describe, expect, it } from "vitest";
import { prisma } from "@/lib/prisma";
import { createTestEvent, createTestOrganization, createTestUser, addMembership } from "@/lib/test-fixtures";
import { handleSellTickets } from "@/lib/sync-handlers";
import {
  densityAlertType,
  fillPercentage,
  shouldFireNewAlert,
  calculateZoneDensity,
  checkDensityThresholds,
  runDensityMonitoring,
  resolveDensityAlert,
} from "@/lib/crowd-density";

function uniqueCode() {
  return `DENS-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

async function newOrganizer(phone?: string) {
  const user = await createTestUser();
  const organization = await createTestOrganization();
  await addMembership(organization.id, user.id, "OWNER");
  if (phone) await prisma.user.update({ where: { id: user.id }, data: { phone } });
  return { user, organizationId: organization.id };
}

// Sells `count` tickets for ticketTypeId and immediately checks every one of
// them in — moving a zone's occupancy, since this codebase has no exit
// scanning (see crowd-density.ts's header comment) and occupancy is just a
// checked-in count. Flips checkedIn directly with one bulk update rather
// than looping handleCheckIn per ticket — these tests are about density
// calculation reading Ticket.checkedIn, not about exercising the gate
// scanner's own payment/already-checked-in logic, and a real handleCheckIn
// round-trip per ticket against the remote test DB is what was blowing past
// this suite's default per-test timeout for anything above a handful of
// tickets.
async function sellAndCheckIn(buyerId: string, eventId: string, ticketTypeId: string, count: number) {
  if (count === 0) return;
  const codes = Array.from({ length: count }, () => uniqueCode());
  const result = await handleSellTickets(buyerId, {
    clientId: uniqueCode(),
    eventId,
    items: [{ ticketTypeId, quantity: count, codes }],
  });
  if (!result.ok || !result.order) throw new Error(`test setup: handleSellTickets failed — ${JSON.stringify(result)}`);
  const ticketIds = result.order.tickets.map((t: { id: string }) => t.id);
  await prisma.ticket.updateMany({ where: { id: { in: ticketIds } }, data: { checkedIn: true, checkedInAt: new Date() } });
}

describe("densityAlertType", () => {
  it("returns null below 80% capacity", () => {
    expect(densityAlertType(0, 20)).toBeNull();
    expect(densityAlertType(15, 20)).toBeNull(); // 75%
  });

  it("returns APPROACHING from 80% up to (not including) 95%", () => {
    expect(densityAlertType(16, 20)).toBe("APPROACHING"); // 80%
    expect(densityAlertType(18, 20)).toBe("APPROACHING"); // 90%
  });

  it("returns AT_CAPACITY from 95% up to (not including) 100%", () => {
    expect(densityAlertType(19, 20)).toBe("AT_CAPACITY"); // 95%
  });

  it("returns OVERCROWDED at 100% and beyond", () => {
    expect(densityAlertType(20, 20)).toBe("OVERCROWDED");
    expect(densityAlertType(30, 20)).toBe("OVERCROWDED"); // 150%
  });
});

describe("fillPercentage", () => {
  it("rounds to the nearest whole percent", () => {
    expect(fillPercentage(16, 20)).toBe(80);
    expect(fillPercentage(1, 3)).toBe(33);
  });
});

describe("shouldFireNewAlert", () => {
  it("never fires when the zone isn't currently in an alert state", () => {
    expect(shouldFireNewAlert(null, null)).toBe(false);
    expect(shouldFireNewAlert(null, "APPROACHING")).toBe(false);
  });

  it("fires on a fresh crossing when no unresolved alert exists yet", () => {
    expect(shouldFireNewAlert("APPROACHING", null)).toBe(true);
  });

  it("does not fire again while parked at the same level as the unresolved alert", () => {
    expect(shouldFireNewAlert("APPROACHING", "APPROACHING")).toBe(false);
  });

  it("fires again on escalation past the unresolved alert's level", () => {
    expect(shouldFireNewAlert("AT_CAPACITY", "APPROACHING")).toBe(true);
    expect(shouldFireNewAlert("OVERCROWDED", "AT_CAPACITY")).toBe(true);
  });

  it("does not fire on de-escalation while the worse alert is still unresolved", () => {
    expect(shouldFireNewAlert("APPROACHING", "AT_CAPACITY")).toBe(false);
  });
});

describe("calculateZoneDensity", () => {
  it("is zero, partial, at capacity, and over capacity at each check-in level", async () => {
    const { organizationId } = await newOrganizer();
    const buyer = await createTestUser();
    const event = await createTestEvent(organizationId, [
      { name: "Pitch", priceCents: 100000, quantityTotal: 30, physicalCapacity: 20 },
    ]);
    const ticketTypeId = event.ticketTypes[0].id;

    expect(await calculateZoneDensity(event.id, "Pitch")).toBe(0);

    await sellAndCheckIn(buyer.id, event.id, ticketTypeId, 10);
    expect(await calculateZoneDensity(event.id, "Pitch")).toBe(10); // partial

    await sellAndCheckIn(buyer.id, event.id, ticketTypeId, 10);
    expect(await calculateZoneDensity(event.id, "Pitch")).toBe(20); // exactly at physical capacity

    await sellAndCheckIn(buyer.id, event.id, ticketTypeId, 5);
    expect(await calculateZoneDensity(event.id, "Pitch")).toBe(25); // over physical capacity (quantityTotal allows it)
  });

  it("returns zero for a zone name that doesn't exist on the event", async () => {
    const { organizationId } = await newOrganizer();
    const event = await createTestEvent(organizationId, [{ priceCents: 100000, quantityTotal: 10 }]);
    expect(await calculateZoneDensity(event.id, "No Such Zone")).toBe(0);
  });
});

describe("checkDensityThresholds", () => {
  // Neon latency under load — five sequential DB-heavy threshold checks, same pattern as Session 7
  it("fires APPROACHING, AT_CAPACITY, and OVERCROWDED at the correct occupancy levels", { timeout: 120000 }, async () => {
    const { organizationId } = await newOrganizer();
    const buyer = await createTestUser();
    const event = await createTestEvent(organizationId, [
      { name: "Grandstand", priceCents: 100000, quantityTotal: 30, physicalCapacity: 20 },
    ]);
    const ticketTypeId = event.ticketTypes[0].id;

    let results = await checkDensityThresholds(event.id);
    expect(results[0].alertType).toBeNull(); // 0%

    await sellAndCheckIn(buyer.id, event.id, ticketTypeId, 16);
    results = await checkDensityThresholds(event.id);
    expect(results[0]).toMatchObject({ zoneName: "Grandstand", occupancy: 16, fillPercentage: 80, alertType: "APPROACHING" });

    await sellAndCheckIn(buyer.id, event.id, ticketTypeId, 3);
    results = await checkDensityThresholds(event.id);
    expect(results[0]).toMatchObject({ occupancy: 19, fillPercentage: 95, alertType: "AT_CAPACITY" });

    await sellAndCheckIn(buyer.id, event.id, ticketTypeId, 1);
    results = await checkDensityThresholds(event.id);
    expect(results[0]).toMatchObject({ occupancy: 20, fillPercentage: 100, alertType: "OVERCROWDED" });

    await sellAndCheckIn(buyer.id, event.id, ticketTypeId, 5);
    results = await checkDensityThresholds(event.id);
    expect(results[0]).toMatchObject({ occupancy: 25, fillPercentage: 125, alertType: "OVERCROWDED" });
  });

  it("excludes ticket types with no physicalCapacity set — no zone, no monitoring", async () => {
    const { organizationId } = await newOrganizer();
    const event = await createTestEvent(organizationId, [
      { name: "General", priceCents: 100000, quantityTotal: 10 }, // no physicalCapacity
    ]);
    expect(await checkDensityThresholds(event.id)).toEqual([]);
  });
});

describe("runDensityMonitoring", () => {
  it("creates exactly one DensityAlert per threshold crossing, not on repeated checks at the same level", async () => {
    const { organizationId } = await newOrganizer();
    const buyer = await createTestUser();
    const event = await createTestEvent(organizationId, [
      { name: "North Terrace", priceCents: 100000, quantityTotal: 30, physicalCapacity: 20 },
    ]);
    const ticketTypeId = event.ticketTypes[0].id;

    await sellAndCheckIn(buyer.id, event.id, ticketTypeId, 16); // 80% -> APPROACHING

    const first = await runDensityMonitoring(event.id);
    expect(first.newAlerts).toEqual([{ zoneName: "North Terrace", alertType: "APPROACHING" }]);
    expect(await prisma.densityAlert.count({ where: { eventId: event.id, zoneName: "North Terrace" } })).toBe(1);

    // Same occupancy, polled again (mirrors the live dashboard's 30s poll) —
    // must not create a duplicate.
    const second = await runDensityMonitoring(event.id);
    expect(second.newAlerts).toEqual([]);
    expect(await prisma.densityAlert.count({ where: { eventId: event.id, zoneName: "North Terrace" } })).toBe(1);

    // Escalates past the still-unresolved APPROACHING alert -> a new,
    // worse alert fires.
    await sellAndCheckIn(buyer.id, event.id, ticketTypeId, 3); // 95% -> AT_CAPACITY
    const third = await runDensityMonitoring(event.id);
    expect(third.newAlerts).toEqual([{ zoneName: "North Terrace", alertType: "AT_CAPACITY" }]);
    expect(await prisma.densityAlert.count({ where: { eventId: event.id, zoneName: "North Terrace" } })).toBe(2);
  });

  it("re-alerts after a resolved alert if the zone is still over threshold", async () => {
    const { organizationId } = await newOrganizer();
    const buyer = await createTestUser();
    const event = await createTestEvent(organizationId, [
      { name: "VIP Enclosure", priceCents: 100000, quantityTotal: 30, physicalCapacity: 20 },
    ]);
    const ticketTypeId = event.ticketTypes[0].id;

    await sellAndCheckIn(buyer.id, event.id, ticketTypeId, 16); // 80%
    const { newAlerts } = await runDensityMonitoring(event.id);
    expect(newAlerts).toHaveLength(1);

    const alert = await prisma.densityAlert.findFirstOrThrow({ where: { eventId: event.id, zoneName: "VIP Enclosure" } });
    await resolveDensityAlert(alert.id, "Jane Organiser", "Additional barriers added");

    // Still at 80% with no unresolved alert left -> fires again.
    const again = await runDensityMonitoring(event.id);
    expect(again.newAlerts).toEqual([{ zoneName: "VIP Enclosure", alertType: "APPROACHING" }]);
    expect(await prisma.densityAlert.count({ where: { eventId: event.id, zoneName: "VIP Enclosure" } })).toBe(2);
  });

  it("sends a WhatsApp notification to the organisation owner when a new alert fires", async () => {
    const phone = "0712345678";
    const { organizationId } = await newOrganizer(phone);
    const buyer = await createTestUser();
    const event = await createTestEvent(organizationId, [
      { name: "Pitch Side", priceCents: 100000, quantityTotal: 30, physicalCapacity: 20 },
    ]);
    await sellAndCheckIn(buyer.id, event.id, event.ticketTypes[0].id, 16);

    await runDensityMonitoring(event.id);

    const logs = await prisma.notificationLog.findMany({ where: { type: "DENSITY_ALERT", recipient: phone } });
    expect(logs).toHaveLength(1);
    expect(logs[0].body).toBe("⚠️ SAFETY ALERT: Pitch Side is at 80% capacity (16 people). Take action immediately.");
  });

  it("sends the OVERCROWDED urgent message when a zone exceeds safe capacity", async () => {
    const phone = "0712345679";
    const { organizationId } = await newOrganizer(phone);
    const buyer = await createTestUser();
    const event = await createTestEvent(organizationId, [
      { name: "Main Stand", priceCents: 100000, quantityTotal: 30, physicalCapacity: 20 },
    ]);
    await sellAndCheckIn(buyer.id, event.id, event.ticketTypes[0].id, 20); // 100%

    await runDensityMonitoring(event.id);

    const logs = await prisma.notificationLog.findMany({ where: { type: "DENSITY_ALERT", recipient: phone } });
    expect(logs).toHaveLength(1);
    expect(logs[0].body).toBe("🚨 OVERCROWDED: Main Stand has exceeded safe capacity. Stop entry immediately.");
  });

  it("does not send WhatsApp when the organisation owner has no phone on file", async () => {
    const { organizationId } = await newOrganizer(); // no phone
    const buyer = await createTestUser();
    const event = await createTestEvent(organizationId, [
      { name: "No Phone Zone", priceCents: 100000, quantityTotal: 30, physicalCapacity: 20 },
    ]);

    const before = await prisma.notificationLog.count({ where: { type: "DENSITY_ALERT" } });
    await sellAndCheckIn(buyer.id, event.id, event.ticketTypes[0].id, 16);
    await runDensityMonitoring(event.id);
    const after = await prisma.notificationLog.count({ where: { type: "DENSITY_ALERT" } });

    expect(after).toBe(before);
    // The alert itself is still created even though nobody could be texted.
    expect(await prisma.densityAlert.count({ where: { eventId: event.id, zoneName: "No Phone Zone" } })).toBe(1);
  });
});

describe("resolveDensityAlert", () => {
  it("saves resolvedAt, resolvedBy, and the resolution note", async () => {
    const { organizationId } = await newOrganizer();
    const event = await createTestEvent(organizationId, [
      { name: "Terrace", priceCents: 100000, quantityTotal: 10, physicalCapacity: 5 },
    ]);
    const alert = await prisma.densityAlert.create({
      data: { eventId: event.id, zoneName: "Terrace", alertType: "APPROACHING", message: "test" },
    });

    const resolved = await resolveDensityAlert(alert.id, "Jane Organiser", "Redirected crowd to Zone B");

    expect(resolved.resolvedAt).not.toBeNull();
    expect(resolved.resolvedBy).toBe("Jane Organiser");
    expect(resolved.resolutionNote).toBe("Redirected crowd to Zone B");

    const reloaded = await prisma.densityAlert.findUniqueOrThrow({ where: { id: alert.id } });
    expect(reloaded.resolvedAt).not.toBeNull();
    expect(reloaded.resolutionNote).toBe("Redirected crowd to Zone B");
  });
});
