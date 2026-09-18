import { prisma } from "@/lib/prisma";
import { sendNotification } from "@/lib/notifications";

// Session 29 — real-time crowd-density safety monitoring. A "zone" is a
// TicketType with physicalCapacity set (see TicketType.physicalCapacity's
// schema comment for why) — this codebase has no separate zone/gate model.
// Occupancy is a simple check-in count: Ticket has no exit-scan/checkedOutAt
// field anywhere in this schema, so "attendees currently in the zone" is
// approximated as "attendees who have checked in," per the spec's own
// documented fallback for when exit scanning doesn't exist.

export type DensityAlertType = "APPROACHING" | "AT_CAPACITY" | "OVERCROWDED";

const SEVERITY: Record<DensityAlertType, number> = {
  APPROACHING: 1,
  AT_CAPACITY: 2,
  OVERCROWDED: 3,
};

export interface ZoneOccupancy {
  zoneName: string;
  occupancy: number;
  physicalCapacity: number;
}

export interface ZoneDensityResult extends ZoneOccupancy {
  fillPercentage: number;
  alertType: DensityAlertType | null;
}

// APPROACHING at 80% of physicalCapacity, AT_CAPACITY at 95%, OVERCROWDED at
// 100%+ — null (no alert) below 80%.
export function densityAlertType(occupancy: number, physicalCapacity: number): DensityAlertType | null {
  if (physicalCapacity <= 0) return null;
  const ratio = occupancy / physicalCapacity;
  if (ratio >= 1) return "OVERCROWDED";
  if (ratio >= 0.95) return "AT_CAPACITY";
  if (ratio >= 0.8) return "APPROACHING";
  return null;
}

export function fillPercentage(occupancy: number, physicalCapacity: number): number {
  if (physicalCapacity <= 0) return 0;
  return Math.round((occupancy / physicalCapacity) * 100);
}

export function evaluateZoneDensities(zones: ZoneOccupancy[]): ZoneDensityResult[] {
  return zones.map((z) => ({
    ...z,
    fillPercentage: fillPercentage(z.occupancy, z.physicalCapacity),
    alertType: densityAlertType(z.occupancy, z.physicalCapacity),
  }));
}

// A new DensityAlert record should only be created when the zone's density
// has gotten WORSE than whatever unresolved alert already exists for it
// (or there is no unresolved alert at all) — never on every poll while it
// sits parked at the same level, and never merely because it improved but
// hasn't been resolved yet. This is what makes "alert only fires once per
// zone per threshold crossing" true even though checkDensityThresholds runs
// fresh on every 30s live-dashboard poll.
export function shouldFireNewAlert(
  currentAlertType: DensityAlertType | null,
  latestUnresolvedAlertType: DensityAlertType | null
): boolean {
  if (currentAlertType === null) return false;
  if (latestUnresolvedAlertType === null) return true;
  return SEVERITY[currentAlertType] > SEVERITY[latestUnresolvedAlertType];
}

export function densityAlertMessage(zone: {
  zoneName: string;
  fillPercentage: number;
  occupancy: number;
  alertType: DensityAlertType;
}): string {
  if (zone.alertType === "OVERCROWDED") {
    return `🚨 OVERCROWDED: ${zone.zoneName} has exceeded safe capacity. Stop entry immediately.`;
  }
  return `⚠️ SAFETY ALERT: ${zone.zoneName} is at ${zone.fillPercentage}% capacity (${zone.occupancy} people). Take action immediately.`;
}

const CHECKED_IN_ORDER_STATUSES = ["PAID", "NEEDS_REVIEW"] as const;

export async function calculateZoneDensity(eventId: string, zoneName: string): Promise<number> {
  const zone = await prisma.ticketType.findFirst({ where: { eventId, name: zoneName }, select: { id: true } });
  if (!zone) return 0;
  return prisma.ticket.count({
    where: { ticketTypeId: zone.id, checkedIn: true, order: { status: { in: [...CHECKED_IN_ORDER_STATUSES] } } },
  });
}

export async function checkDensityThresholds(eventId: string): Promise<ZoneDensityResult[]> {
  const zones = await prisma.ticketType.findMany({
    where: { eventId, physicalCapacity: { not: null } },
    select: { id: true, name: true, physicalCapacity: true },
  });
  if (zones.length === 0) return [];

  const occupancies = await Promise.all(
    zones.map((z) =>
      prisma.ticket.count({
        where: { ticketTypeId: z.id, checkedIn: true, order: { status: { in: [...CHECKED_IN_ORDER_STATUSES] } } },
      })
    )
  );

  return evaluateZoneDensities(
    zones.map((z, i) => ({ zoneName: z.name, occupancy: occupancies[i], physicalCapacity: z.physicalCapacity! }))
  );
}

export interface DensityMonitoringResult {
  zones: ZoneDensityResult[];
  newAlerts: { zoneName: string; alertType: DensityAlertType }[];
}

// Called on every 30s live-dashboard poll (see the live route) — computes
// current density for every zone, creates a DensityAlert + sends the
// organiser a WhatsApp for any zone whose alert level just got worse, and
// leaves everything else untouched. Best-effort on the WhatsApp send,
// skipped silently when the org's OWNER has no phone on file — same
// discipline as every other WhatsApp send in this codebase (see
// LOW_WALLET_BALANCE in handleChargeWallet, src/lib/sync-handlers.ts).
export async function runDensityMonitoring(eventId: string): Promise<DensityMonitoringResult> {
  const zones = await checkDensityThresholds(eventId);
  const newAlerts: DensityMonitoringResult["newAlerts"] = [];
  if (zones.length === 0) return { zones, newAlerts };

  const unresolved = await prisma.densityAlert.findMany({
    where: { eventId, resolvedAt: null },
    orderBy: { triggeredAt: "desc" },
  });
  const latestUnresolvedByZone = new Map<string, DensityAlertType>();
  for (const a of unresolved) {
    if (!latestUnresolvedByZone.has(a.zoneName)) {
      latestUnresolvedByZone.set(a.zoneName, a.alertType as DensityAlertType);
    }
  }

  const zonesToAlert = zones.filter((z) =>
    shouldFireNewAlert(z.alertType, latestUnresolvedByZone.get(z.zoneName) ?? null)
  );
  if (zonesToAlert.length === 0) return { zones, newAlerts };

  const event = await prisma.event.findUnique({ where: { id: eventId }, select: { organizationId: true } });
  const owner = event
    ? await prisma.organizationMembership.findFirst({
        where: { organizationId: event.organizationId, role: "OWNER" },
        include: { user: { select: { phone: true } } },
      })
    : null;

  for (const zone of zonesToAlert) {
    const alertType = zone.alertType as DensityAlertType;
    const message = densityAlertMessage({ ...zone, alertType });
    await prisma.densityAlert.create({ data: { eventId, zoneName: zone.zoneName, alertType, message } });
    newAlerts.push({ zoneName: zone.zoneName, alertType });

    if (owner?.user.phone) {
      await sendNotification({
        type: "DENSITY_ALERT",
        channel: "WHATSAPP",
        recipient: owner.user.phone,
        subject: `Safety alert — ${zone.zoneName}`,
        body: message,
      });
    }
  }

  return { zones, newAlerts };
}

export async function resolveDensityAlert(alertId: string, resolvedBy: string, resolutionNote?: string) {
  return prisma.densityAlert.update({
    where: { id: alertId },
    data: { resolvedAt: new Date(), resolvedBy, resolutionNote: resolutionNote?.trim() || null },
  });
}
