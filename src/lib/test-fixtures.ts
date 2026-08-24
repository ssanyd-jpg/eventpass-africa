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

export async function createTestEvent(
  organizerId: string,
  ticketTypes: Array<{ priceCents: number; quantityTotal: number; quantitySold?: number }> = [
    { priceCents: 200000, quantityTotal: 10 },
  ],
  currency = "TZS"
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
      organizerId,
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
