import { prisma } from "@/lib/prisma";

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
  vendorOptions: { vendorApplicationsOpen?: boolean; vendorStallFeeCents?: number } = {}
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
