import { PrismaClient } from "@prisma/client";
import bcrypt from "bcryptjs";

const prisma = new PrismaClient();

function daysFromNow(days: number, hour = 19, minute = 0) {
  const d = new Date();
  d.setDate(d.getDate() + days);
  d.setHours(hour, minute, 0, 0);
  return d;
}

function slugify(input: string) {
  return input
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)+/g, "");
}

// Amounts stored as integer minor units (major unit * 100) for consistency
// across every currency field — see src/lib/format.ts.
function tzs(amount: number) {
  return amount * 100;
}
function usd(amount: number) {
  return Math.round(amount * 100);
}

// Same shape as generateTicketCode() in src/lib/format.ts, duplicated here
// rather than imported — seed.ts runs standalone via `tsx` and everything
// else in this file is already self-contained (no @/ path aliases).
function generateCode() {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let code = "";
  for (let i = 0; i < 10; i++) {
    code += chars[Math.floor(Math.random() * chars.length)];
    if (i === 4) code += "-";
  }
  return code;
}

// Every user needs exactly one Organization (see the model comment in
// schema.prisma) — the seed's two demo organizers each get a personal one,
// upserted by userId so re-running the seed doesn't create duplicates.
async function ensureOrganization(user: { id: string; name: string }) {
  const existing = await prisma.organizationMembership.findUnique({ where: { userId: user.id } });
  if (existing) return existing.organizationId;
  const organization = await prisma.organization.create({ data: { name: `${user.name}'s Organization` } });
  await prisma.organizationMembership.create({
    data: { userId: user.id, organizationId: organization.id, role: "OWNER" },
  });
  return organization.id;
}

// Realistic homepage stats (tickets sold, cashless volume) need real Order/
// Ticket/WalletTransaction rows, not just a hand-set counter — but the seed
// must stay safely re-runnable, so every order/sale below is keyed by a
// deterministic clientId and skipped if it already exists. ticketType.
// quantitySold is only ever incremented alongside a *newly created* order,
// never unconditionally, so re-running this script can't double-count it.
async function ensureTicketSale(params: {
  eventId: string;
  eventSlug: string;
  eventCurrency: string;
  ticketTypeName: string;
  buyerId: string;
  buyerTag: string;
  quantity: number;
}) {
  const clientId = `seed-order-${params.eventSlug}-${slugify(params.ticketTypeName)}-${params.buyerTag}`;
  const existing = await prisma.order.findUnique({ where: { clientId } });
  if (existing) return;

  const ticketType = await prisma.ticketType.findFirst({
    where: { eventId: params.eventId, name: params.ticketTypeName },
  });
  if (!ticketType) return;

  const totalCents = ticketType.priceCents * params.quantity;
  const order = await prisma.order.create({
    data: {
      clientId,
      status: "PAID",
      totalCents,
      currency: params.eventCurrency,
      userId: params.buyerId,
      eventId: params.eventId,
      items: {
        create: [{ quantity: params.quantity, unitPriceCents: ticketType.priceCents, ticketTypeId: ticketType.id }],
      },
    },
  });

  for (let i = 0; i < params.quantity; i++) {
    await prisma.ticket.create({
      data: {
        clientId: `${clientId}-t${i}`,
        code: generateCode(),
        orderId: order.id,
        eventId: params.eventId,
        ticketTypeId: ticketType.id,
      },
    });
  }

  await prisma.ticketType.update({
    where: { id: ticketType.id },
    data: { quantitySold: { increment: params.quantity } },
  });
}

async function ensureVendor(eventId: string, name: string, badgeCode: string) {
  return prisma.vendor.upsert({
    where: { badgeCode },
    update: {},
    create: { eventId, name, category: "Food", status: "APPROVED", badgeCode },
  });
}

async function ensureWallet(eventId: string, ownerUserId: string, currency: string) {
  return prisma.wallet.upsert({
    where: { eventId_ownerUserId: { eventId, ownerUserId } },
    update: {},
    create: { code: generateCode(), eventId, ownerUserId, currency },
  });
}

// One TOPUP followed by a full SALE of the same amount — the wallet nets to
// zero (the attendee loaded exactly what they spent), and the SALE half is
// what the homepage's "cashless volume processed" stat and the organizer
// analytics' spend-by-vendor both sum. Keyed by clientId so re-seeding never
// double-spends the same simulated tap.
async function ensureWalletSale(params: {
  wallet: { id: string };
  vendorId: string;
  amountCents: number;
  currency: string;
  clientIdBase: string;
  item: string;
}) {
  const saleClientId = `${params.clientIdBase}-sale`;
  const existing = await prisma.walletTransaction.findUnique({ where: { clientId: saleClientId } });
  if (existing) return;

  await prisma.walletTransaction.create({
    data: {
      clientId: `${params.clientIdBase}-topup`,
      type: "TOPUP",
      status: "COMPLETED",
      amountCents: params.amountCents,
      currency: params.currency,
      walletId: params.wallet.id,
    },
  });
  await prisma.walletTransaction.create({
    data: {
      clientId: saleClientId,
      type: "SALE",
      status: "COMPLETED",
      amountCents: params.amountCents,
      currency: params.currency,
      walletId: params.wallet.id,
      vendorId: params.vendorId,
      item: params.item,
    },
  });
}

async function main() {
  const demoPassword = await bcrypt.hash("password123", 10);

  const organizer = await prisma.user.upsert({
    where: { email: "organizer@chaap.dev" },
    update: {},
    create: {
      name: "Nova Events Co.",
      email: "organizer@chaap.dev",
      passwordHash: demoPassword,
    },
  });

  const secondOrganizer = await prisma.user.upsert({
    where: { email: "promoter@chaap.dev" },
    update: {},
    create: {
      name: "Skyline Presents",
      email: "promoter@chaap.dev",
      passwordHash: demoPassword,
    },
  });

  const organizationId = await ensureOrganization(organizer);
  const secondOrganizationId = await ensureOrganization(secondOrganizer);

  const fan = await prisma.user.upsert({
    where: { email: "fan@chaap.dev" },
    update: {},
    create: {
      name: "Alex Rivera",
      email: "fan@chaap.dev",
      passwordHash: demoPassword,
    },
  });
  await ensureOrganization(fan);

  const admin = await prisma.user.upsert({
    where: { email: "admin@chaap.dev" },
    update: {},
    create: {
      name: "Platform Admin",
      email: "admin@chaap.dev",
      passwordHash: demoPassword,
      role: "ADMIN",
    },
  });
  await ensureOrganization(admin);

  // A small pool of realistic attendee accounts (distinct from fan@chaap.dev)
  // that the ticket/wallet seeding below spreads purchases and cashless
  // spend across, so the homepage stats aren't the output of one buyer
  // placing one enormous order.
  const buyerRoster: { tag: string; name: string; email: string }[] = [
    { tag: "amina", name: "Amina Juma", email: "amina.juma@chaap.dev" },
    { tag: "brian", name: "Brian Otieno", email: "brian.otieno@chaap.dev" },
    { tag: "grace", name: "Grace Mwangi", email: "grace.mwangi@chaap.dev" },
    { tag: "daniel", name: "Daniel Mushi", email: "daniel.mushi@chaap.dev" },
    { tag: "fatima", name: "Fatima Ally", email: "fatima.ally@chaap.dev" },
    { tag: "joseph", name: "Joseph Kessy", email: "joseph.kessy@chaap.dev" },
    { tag: "neema", name: "Neema Shirima", email: "neema.shirima@chaap.dev" },
    { tag: "peter", name: "Peter Wanyama", email: "peter.wanyama@chaap.dev" },
    { tag: "zainab", name: "Zainab Mrisho", email: "zainab.mrisho@chaap.dev" },
    { tag: "kevin", name: "Kevin Bundala", email: "kevin.bundala@chaap.dev" },
  ];
  const buyers: Record<string, { id: string }> = {};
  for (const b of buyerRoster) {
    const user = await prisma.user.upsert({
      where: { email: b.email },
      update: {},
      create: { name: b.name, email: b.email, passwordHash: demoPassword },
    });
    await ensureOrganization(user);
    buyers[b.tag] = user;
  }

  const events = [
    {
      title: "Bongo Beats Festival",
      description:
        "A three-stage festival celebrating Bongo Flava, Afrobeat, and Amapiano with headline DJs, live bands, and food vendors along the beach. Gates open at 4pm.",
      category: "Music",
      venue: "Coco Beach",
      city: "Dar es Salaam",
      startsAt: daysFromNow(21, 16, 0),
      imageUrl: "https://picsum.photos/seed/bongo-beats/1200/675",
      organizationId,
      ticketTypes: [
        { name: "General Admission", priceCents: tzs(20000), quantityTotal: 400 },
        { name: "VIP", priceCents: tzs(60000), quantityTotal: 80 },
        { name: "Backstage Pass", priceCents: tzs(120000), quantityTotal: 20 },
      ],
    },
    {
      title: "Dar Comedy Night",
      description:
        "An evening of stand-up comedy with four of East Africa's rising comedians. 18+ show, cash bar available.",
      category: "Comedy",
      venue: "Alliance Française",
      city: "Dar es Salaam",
      startsAt: daysFromNow(9, 20, 0),
      imageUrl: "https://picsum.photos/seed/dar-comedy/1200/675",
      organizationId,
      ticketTypes: [
        { name: "Standard Seat", priceCents: tzs(15000), quantityTotal: 150 },
        { name: "Front Row", priceCents: tzs(30000), quantityTotal: 24 },
      ],
    },
    {
      title: "Kilimanjaro Marathon",
      description:
        "Run the iconic route beneath Mount Kilimanjaro in this annual marathon and 10K. Includes finisher medal, timing chip, and post-race festival.",
      category: "Sports",
      venue: "Moshi Stadium",
      city: "Moshi",
      startsAt: daysFromNow(45, 7, 0),
      imageUrl: "https://picsum.photos/seed/kilimanjaro-marathon/1200/675",
      organizationId: secondOrganizationId,
      // Post-race festival has room for free water/gear stalls — demonstrates
      // the no-fee vendor path.
      vendorApplicationsOpen: true,
      vendorStallFeeCents: 0,
      ticketTypes: [
        { name: "10K Entry", priceCents: tzs(25000), quantityTotal: 500 },
        { name: "Full Marathon Entry", priceCents: tzs(45000), quantityTotal: 300 },
      ],
    },
    {
      title: "East Africa Tech Summit",
      description:
        "Two days of talks and workshops on AI, mobile money, and developer tooling from engineers across the region.",
      category: "Conference",
      venue: "Julius Nyerere International Convention Centre",
      city: "Dar es Salaam",
      startsAt: daysFromNow(60, 9, 0),
      imageUrl: "https://picsum.photos/seed/ea-tech-summit/1200/675",
      organizationId: secondOrganizationId,
      // International conference, priced in USD — demonstrates an event
      // with a currency other than the platform default.
      currency: "USD",
      ticketTypes: [
        { name: "General Pass", priceCents: usd(65), quantityTotal: 600 },
        { name: "Workshop Pass", priceCents: usd(110), quantityTotal: 150 },
        { name: "Student Pass", priceCents: usd(20), quantityTotal: 100 },
      ],
    },
    {
      title: "Zanzibar Acoustic Sessions",
      description:
        "An intimate acoustic evening overlooking the harbour, featuring stripped-down performances from Taarab-influenced singer-songwriters.",
      category: "Music",
      venue: "Forodhani Gardens",
      city: "Zanzibar City",
      startsAt: daysFromNow(14, 19, 30),
      imageUrl: "https://picsum.photos/seed/zanzibar-acoustic/1200/675",
      organizationId,
      ticketTypes: [
        { name: "Standing", priceCents: tzs(20000), quantityTotal: 200 },
        { name: "Seated", priceCents: tzs(35000), quantityTotal: 180 },
        { name: "Meet & Greet", priceCents: tzs(80000), quantityTotal: 30 },
      ],
    },
    {
      title: "Arusha Harvest & Wine Fair",
      description:
        "Sample dishes from 40+ local restaurants paired with regional wines from the Southern Highlands. Live band and chef demos all evening.",
      category: "Festival",
      venue: "Arusha International Conference Centre Grounds",
      city: "Arusha",
      startsAt: daysFromNow(30, 17, 0),
      imageUrl: "https://picsum.photos/seed/arusha-harvest/1200/675",
      organizationId: secondOrganizationId,
      // This event is literally built around vendor stalls (the "40+ local
      // restaurants" in the description) — demonstrates the paid vendor path.
      vendorApplicationsOpen: true,
      vendorStallFeeCents: tzs(15000),
      ticketTypes: [
        { name: "Entry + 5 Tastings", priceCents: tzs(25000), quantityTotal: 350 },
        { name: "Unlimited Tastings", priceCents: tzs(45000), quantityTotal: 150 },
      ],
    },
  ];

  const eventsBySlug: Record<string, { id: string; slug: string; currency: string }> = {};
  for (const e of events) {
    const slug = slugify(e.title);
    const created = await prisma.event.upsert({
      where: { slug },
      update: {},
      create: {
        slug,
        title: e.title,
        description: e.description,
        category: e.category,
        venue: e.venue,
        city: e.city,
        startsAt: e.startsAt,
        imageUrl: e.imageUrl,
        currency: "currency" in e ? e.currency : "TZS",
        vendorApplicationsOpen: "vendorApplicationsOpen" in e ? e.vendorApplicationsOpen : false,
        vendorStallFeeCents: "vendorStallFeeCents" in e ? e.vendorStallFeeCents : 0,
        organizationId: e.organizationId,
        ticketTypes: { create: e.ticketTypes },
      },
    });
    eventsBySlug[slug] = created;
  }

  // Realistic ticket sales — enough sell-through on each event's ticket
  // types that the homepage's "tickets sold" stat (a straight sum of
  // TicketType.quantitySold) reads like a real platform rather than a fresh
  // install. Totals ~150 tickets across all six events.
  const ticketSales: {
    eventSlug: string;
    ticketTypeName: string;
    sales: { buyer: string; quantity: number }[];
  }[] = [
    {
      eventSlug: "bongo-beats-festival",
      ticketTypeName: "General Admission",
      sales: [
        { buyer: "amina", quantity: 10 },
        { buyer: "brian", quantity: 12 },
        { buyer: "grace", quantity: 8 },
        { buyer: "daniel", quantity: 6 },
      ],
    },
    {
      eventSlug: "bongo-beats-festival",
      ticketTypeName: "VIP",
      sales: [
        { buyer: "fatima", quantity: 3 },
        { buyer: "joseph", quantity: 5 },
      ],
    },
    {
      eventSlug: "bongo-beats-festival",
      ticketTypeName: "Backstage Pass",
      sales: [{ buyer: "neema", quantity: 2 }],
    },
    {
      eventSlug: "dar-comedy-night",
      ticketTypeName: "Standard Seat",
      sales: [
        { buyer: "peter", quantity: 8 },
        { buyer: "zainab", quantity: 7 },
        { buyer: "kevin", quantity: 5 },
      ],
    },
    {
      eventSlug: "dar-comedy-night",
      ticketTypeName: "Front Row",
      sales: [{ buyer: "amina", quantity: 5 }],
    },
    {
      eventSlug: "kilimanjaro-marathon",
      ticketTypeName: "10K Entry",
      sales: [
        { buyer: "brian", quantity: 10 },
        { buyer: "grace", quantity: 9 },
        { buyer: "daniel", quantity: 6 },
      ],
    },
    {
      eventSlug: "kilimanjaro-marathon",
      ticketTypeName: "Full Marathon Entry",
      sales: [
        { buyer: "fatima", quantity: 4 },
        { buyer: "joseph", quantity: 6 },
      ],
    },
    {
      eventSlug: "east-africa-tech-summit",
      ticketTypeName: "General Pass",
      sales: [
        { buyer: "neema", quantity: 3 },
        { buyer: "peter", quantity: 3 },
      ],
    },
    {
      eventSlug: "east-africa-tech-summit",
      ticketTypeName: "Workshop Pass",
      sales: [{ buyer: "zainab", quantity: 2 }],
    },
    {
      eventSlug: "east-africa-tech-summit",
      ticketTypeName: "Student Pass",
      sales: [{ buyer: "kevin", quantity: 2 }],
    },
    {
      eventSlug: "zanzibar-acoustic-sessions",
      ticketTypeName: "Standing",
      sales: [
        { buyer: "amina", quantity: 5 },
        { buyer: "brian", quantity: 5 },
      ],
    },
    {
      eventSlug: "zanzibar-acoustic-sessions",
      ticketTypeName: "Seated",
      sales: [
        { buyer: "grace", quantity: 4 },
        { buyer: "daniel", quantity: 2 },
      ],
    },
    {
      eventSlug: "zanzibar-acoustic-sessions",
      ticketTypeName: "Meet & Greet",
      sales: [{ buyer: "fatima", quantity: 2 }],
    },
    {
      eventSlug: "arusha-harvest-wine-fair",
      ticketTypeName: "Entry + 5 Tastings",
      sales: [
        { buyer: "joseph", quantity: 7 },
        { buyer: "neema", quantity: 5 },
      ],
    },
    {
      eventSlug: "arusha-harvest-wine-fair",
      ticketTypeName: "Unlimited Tastings",
      sales: [{ buyer: "peter", quantity: 4 }],
    },
  ];

  for (const group of ticketSales) {
    const event = eventsBySlug[group.eventSlug];
    if (!event) continue;
    for (const sale of group.sales) {
      const buyer = buyers[sale.buyer];
      if (!buyer) continue;
      await ensureTicketSale({
        eventId: event.id,
        eventSlug: event.slug,
        eventCurrency: event.currency,
        ticketTypeName: group.ticketTypeName,
        buyerId: buyer.id,
        buyerTag: sale.buyer,
        quantity: sale.quantity,
      });
    }
  }

  // Realistic cashless (wallet) spend — one vendor per event, a handful of
  // attendees tapping to pay. Only the five TZS-denominated events get
  // wallet activity: the homepage's "cashless volume processed" stat is
  // reported in TZS only (see getPlatformStats), so USD spend at the Tech
  // Summit wouldn't show up there anyway. Totals TZS 3,200,000.
  const walletSales: {
    eventSlug: string;
    vendorName: string;
    badgeCode: string;
    item: string;
    spends: { buyer: string; amountTzs: number }[];
  }[] = [
    {
      eventSlug: "bongo-beats-festival",
      vendorName: "Beach Grill & Bar",
      badgeCode: "SEED-VENDOR-bongo-beats-festival",
      item: "Food & drinks",
      spends: [
        { buyer: "amina", amountTzs: 200000 },
        { buyer: "brian", amountTzs: 250000 },
        { buyer: "grace", amountTzs: 150000 },
        { buyer: "daniel", amountTzs: 180000 },
        { buyer: "fatima", amountTzs: 220000 },
        { buyer: "joseph", amountTzs: 200000 },
      ],
    },
    {
      eventSlug: "dar-comedy-night",
      vendorName: "Lobby Bar",
      badgeCode: "SEED-VENDOR-dar-comedy-night",
      item: "Drinks",
      spends: [
        { buyer: "peter", amountTzs: 120000 },
        { buyer: "zainab", amountTzs: 100000 },
        { buyer: "kevin", amountTzs: 80000 },
      ],
    },
    {
      eventSlug: "kilimanjaro-marathon",
      vendorName: "Finish Line Refreshments",
      badgeCode: "SEED-VENDOR-kilimanjaro-marathon",
      item: "Snacks & drinks",
      spends: [
        { buyer: "brian", amountTzs: 150000 },
        { buyer: "grace", amountTzs: 130000 },
        { buyer: "daniel", amountTzs: 120000 },
        { buyer: "fatima", amountTzs: 100000 },
      ],
    },
    {
      eventSlug: "zanzibar-acoustic-sessions",
      vendorName: "Harbour Cafe",
      badgeCode: "SEED-VENDOR-zanzibar-acoustic-sessions",
      item: "Food & drinks",
      spends: [
        { buyer: "amina", amountTzs: 90000 },
        { buyer: "brian", amountTzs: 80000 },
        { buyer: "grace", amountTzs: 80000 },
      ],
    },
    {
      eventSlug: "arusha-harvest-wine-fair",
      vendorName: "Tasting Pavilion",
      badgeCode: "SEED-VENDOR-arusha-harvest-wine-fair",
      item: "Extra tastings",
      spends: [
        { buyer: "joseph", amountTzs: 300000 },
        { buyer: "neema", amountTzs: 250000 },
        { buyer: "peter", amountTzs: 200000 },
        { buyer: "kevin", amountTzs: 200000 },
      ],
    },
  ];

  for (const group of walletSales) {
    const event = eventsBySlug[group.eventSlug];
    if (!event) continue;
    const vendor = await ensureVendor(event.id, group.vendorName, group.badgeCode);
    for (const spend of group.spends) {
      const buyer = buyers[spend.buyer];
      if (!buyer) continue;
      const wallet = await ensureWallet(event.id, buyer.id, event.currency);
      await ensureWalletSale({
        wallet,
        vendorId: vendor.id,
        amountCents: tzs(spend.amountTzs),
        currency: event.currency,
        clientIdBase: `seed-wallet-${event.slug}-${spend.buyer}`,
        item: group.item,
      });
    }
  }

  console.log("Seed complete.");
  console.log("Demo accounts (password: password123):");
  console.log("  organizer@chaap.dev  (organizer)");
  console.log("  promoter@chaap.dev   (organizer)");
  console.log("  fan@chaap.dev        (attendee)");
  console.log("  admin@chaap.dev      (admin)");
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
