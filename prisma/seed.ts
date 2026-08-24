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

async function main() {
  const demoPassword = await bcrypt.hash("password123", 10);

  const organizer = await prisma.user.upsert({
    where: { email: "organizer@eventpassafrica.dev" },
    update: {},
    create: {
      name: "Nova Events Co.",
      email: "organizer@eventpassafrica.dev",
      passwordHash: demoPassword,
    },
  });

  const secondOrganizer = await prisma.user.upsert({
    where: { email: "promoter@eventpassafrica.dev" },
    update: {},
    create: {
      name: "Skyline Presents",
      email: "promoter@eventpassafrica.dev",
      passwordHash: demoPassword,
    },
  });

  await prisma.user.upsert({
    where: { email: "fan@eventpassafrica.dev" },
    update: {},
    create: {
      name: "Alex Rivera",
      email: "fan@eventpassafrica.dev",
      passwordHash: demoPassword,
    },
  });

  await prisma.user.upsert({
    where: { email: "admin@eventpassafrica.dev" },
    update: {},
    create: {
      name: "Platform Admin",
      email: "admin@eventpassafrica.dev",
      passwordHash: demoPassword,
      role: "ADMIN",
    },
  });

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
      organizerId: organizer.id,
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
      organizerId: organizer.id,
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
      organizerId: secondOrganizer.id,
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
      organizerId: secondOrganizer.id,
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
      organizerId: organizer.id,
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
      organizerId: secondOrganizer.id,
      ticketTypes: [
        { name: "Entry + 5 Tastings", priceCents: tzs(25000), quantityTotal: 350 },
        { name: "Unlimited Tastings", priceCents: tzs(45000), quantityTotal: 150 },
      ],
    },
  ];

  for (const e of events) {
    const slug = slugify(e.title);
    await prisma.event.upsert({
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
        organizerId: e.organizerId,
        ticketTypes: { create: e.ticketTypes },
      },
    });
  }

  console.log("Seed complete.");
  console.log("Demo accounts (password: password123):");
  console.log("  organizer@eventpassafrica.dev  (organizer)");
  console.log("  promoter@eventpassafrica.dev   (organizer)");
  console.log("  fan@eventpassafrica.dev        (attendee)");
  console.log("  admin@eventpassafrica.dev      (admin)");
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
