import { prisma } from "@/lib/prisma";
import { handleSellTickets } from "@/lib/sync-handlers";

let counter = 0;
function unique(prefix: string) {
  counter += 1;
  return `${prefix}-${Date.now()}-${counter}`;
}

export async function createTestUser(overrides: Partial<{ name: string; email: string; role: string }> = {}) {
  return prisma.user.create({
    data: {
      name: overrides.name ?? "Test User",
      email: overrides.email ?? `${unique("user")}@test.local`,
      passwordHash: "unused-in-tests",
      role: overrides.role ?? "USER",
    },
  });
}

export async function createTestOrganization(overrides: Partial<{ name: string }> = {}) {
  return prisma.organization.create({
    data: { name: overrides.name ?? "Test Org" },
  });
}

export async function addMembership(organizationId: string, userId: string, role: "OWNER" | "STAFF" | "GATE_CREW" = "OWNER") {
  return prisma.organizationMembership.create({ data: { organizationId, userId, role } });
}

export async function createTestEvent(
  organizationId: string,
  ticketTypes: Array<{ priceCents: number; quantityTotal: number; quantitySold?: number }> = [
    { priceCents: 200000, quantityTotal: 10 },
  ],
  currency = "TZS",
  vendorOptions: { vendorApplicationsOpen?: boolean; vendorStallFeeCents?: number } = {},
  waiverText: string | null = null
) {
  return prisma.event.create({
    data: {
      slug: unique("event"),
      title: "Test Event",
      description: "",
      category: "Music",
      venue: "Test Venue",
      city: "Dar es Salaam",
      startsAt: new Date(Date.now() + 86400000),
      imageUrl: "https://example.com/x.jpg",
      currency,
      organizationId,
      vendorApplicationsOpen: vendorOptions.vendorApplicationsOpen ?? false,
      vendorStallFeeCents: vendorOptions.vendorStallFeeCents ?? 0,
      waiverText,
      ticketTypes: {
        create: ticketTypes.map((tt) => ({
          name: "General",
          priceCents: tt.priceCents,
          quantityTotal: tt.quantityTotal,
          quantitySold: tt.quantitySold ?? 0,
        })),
      },
    },
    include: { ticketTypes: true },
  });
}

export async function createTestRegistrationQuestion(
  eventId: string,
  overrides: Partial<{ label: string; type: string; options: string; required: boolean; sortOrder: number }> = {}
) {
  return prisma.registrationQuestion.create({
    data: {
      eventId,
      label: overrides.label ?? "Dietary requirements?",
      type: overrides.type ?? "TEXT",
      options: overrides.options,
      required: overrides.required ?? false,
      sortOrder: overrides.sortOrder ?? 0,
    },
  });
}

export async function createTestDiscountCode(
  eventId: string,
  ticketTypeId: string,
  overrides: Partial<{
    code: string;
    type: string;
    percentOff: number;
    amountOffCents: number;
    maxRedemptions: number;
    redemptionCount: number;
    expiresAt: Date;
    active: boolean;
  }> = {}
) {
  return prisma.discountCode.create({
    data: {
      eventId,
      ticketTypeId,
      code: overrides.code ?? unique("CODE").toUpperCase(),
      type: overrides.type ?? "PERCENT_OFF",
      percentOff: overrides.type === "FIXED_AMOUNT_OFF" ? undefined : overrides.percentOff ?? 10,
      amountOffCents: overrides.type === "FIXED_AMOUNT_OFF" ? overrides.amountOffCents ?? 1000 : undefined,
      maxRedemptions: overrides.maxRedemptions,
      redemptionCount: overrides.redemptionCount ?? 0,
      expiresAt: overrides.expiresAt,
      active: overrides.active ?? true,
    },
  });
}

export async function createTestVendor(
  eventId: string,
  overrides: Partial<{ status: string; name: string; badgeCode: string }> = {}
) {
  return prisma.vendor.create({
    data: {
      eventId,
      name: overrides.name ?? "Test Vendor",
      category: "Food",
      status: overrides.status ?? "APPROVED",
      badgeCode: overrides.badgeCode ?? unique("badge"),
    },
  });
}

export async function createTestSponsor(
  eventId: string,
  overrides: Partial<{ name: string; tier: string; feeCents: number }> = {}
) {
  return prisma.sponsor.create({
    data: {
      eventId,
      name: overrides.name ?? "Test Sponsor",
      tier: overrides.tier ?? "Gold",
      feeCents: overrides.feeCents ?? 0,
    },
  });
}

// Promoted from a local helper that settlement-handlers.test.ts had
// (paidOrder) — this variant takes an explicit buyer, since CRM tests need
// multiple orders from the *same* buyer (lifetime-stat aggregation, dedupe).
export async function createPaidOrder(
  organizationId: string,
  buyerUserId: string,
  priceCents: number,
  currency = "TZS"
) {
  const event = await createTestEvent(organizationId, [{ priceCents, quantityTotal: 10 }], currency);
  const tt = event.ticketTypes[0];
  const result = await handleSellTickets(buyerUserId, {
    clientId: unique("order"),
    eventId: event.id,
    items: [{ ticketTypeId: tt.id, quantity: 1, codes: [unique("code")] }],
  });
  return { event, order: result.order };
}

export async function createTestDevice(
  organizationId: string,
  overrides: Partial<{
    deviceId: string;
    label: string;
    revokedAt: Date;
    lastSeenByUserId: string;
    lastSeenByName: string;
  }> = {}
) {
  return prisma.device.create({
    data: {
      organizationId,
      deviceId: overrides.deviceId ?? unique("device"),
      label: overrides.label ?? "",
      lastSeenByUserId: overrides.lastSeenByUserId ?? "seed-user",
      lastSeenByName: overrides.lastSeenByName ?? "Seed User",
      revokedAt: overrides.revokedAt,
    },
  });
}

export async function createTestWallet(
  eventId: string,
  ownerUserId: string,
  overrides: Partial<{ balanceCents: number; currency: string; code: string }> = {}
) {
  return prisma.wallet.create({
    data: {
      eventId,
      ownerUserId,
      code: overrides.code ?? unique("wallet"),
      balanceCents: overrides.balanceCents ?? 0,
      currency: overrides.currency ?? "TZS",
    },
    include: { event: { select: { id: true, clientId: true, status: true, currency: true } } },
  });
}
