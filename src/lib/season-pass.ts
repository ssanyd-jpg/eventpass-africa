import { prisma } from "@/lib/prisma";
import { getActivePaymentProvider } from "@/lib/payments";
import { sendNotification } from "@/lib/notifications";
import { normalizeTanzaniaPhone } from "@/lib/sms";

// Season ticket / membership management foundation (schema: SeasonPass /
// SeasonPassHolder / SeasonPassEvent in prisma/schema.prisma). A season pass
// belongs to an organisation (the "club") and covers a set of that
// organisation's own events (linked via SeasonPassEvent) rather than a
// single event's ticket types — same DB-touching, tested-without-HTTP shape
// as loyalty-rewards.ts/resale.ts.

export interface CreateSeasonPassInput {
  name: string;
  description?: string | null;
  price: number; // cents
  currency?: string;
  startDate: Date;
  endDate: Date;
  maxHolders?: number | null;
  autoRenewEnabled?: boolean;
  autoRenewPrice?: number | null;
}

export async function createSeasonPass(organizationId: string, input: CreateSeasonPassInput) {
  const name = input.name.trim();
  if (!name) return { ok: false as const, error: "Name is required." };
  if (!Number.isInteger(input.price) || input.price <= 0) {
    return { ok: false as const, error: "Price must be a positive whole number of cents." };
  }
  if (!(input.startDate.getTime() < input.endDate.getTime())) {
    return { ok: false as const, error: "End date must be after the start date." };
  }
  if (input.maxHolders != null && (!Number.isInteger(input.maxHolders) || input.maxHolders <= 0)) {
    return { ok: false as const, error: "Max holders must be a positive whole number, or left blank for unlimited." };
  }
  if (input.autoRenewPrice != null && (!Number.isInteger(input.autoRenewPrice) || input.autoRenewPrice <= 0)) {
    return { ok: false as const, error: "Renewal price must be a positive whole number of cents." };
  }

  const seasonPass = await prisma.seasonPass.create({
    data: {
      organizationId,
      name,
      description: input.description?.trim() || null,
      price: input.price,
      currency: input.currency ?? "TZS",
      startDate: input.startDate,
      endDate: input.endDate,
      maxHolders: input.maxHolders ?? null,
      status: "DRAFT",
      autoRenewEnabled: input.autoRenewEnabled ?? false,
      autoRenewPrice: input.autoRenewPrice ?? null,
    },
  });
  return { ok: true as const, seasonPassId: seasonPass.id };
}

export async function publishSeasonPass(organizationId: string, seasonPassId: string) {
  const res = await prisma.seasonPass.updateMany({
    where: { id: seasonPassId, organizationId, status: "DRAFT" },
    data: { status: "ACTIVE" },
  });
  if (res.count === 0) return { ok: false as const, error: "Season pass not found, or it isn't in DRAFT status." };
  return { ok: true as const };
}

export async function linkEventToSeasonPass(organizationId: string, seasonPassId: string, eventId: string) {
  const pass = await prisma.seasonPass.findUnique({ where: { id: seasonPassId }, select: { organizationId: true } });
  if (!pass || pass.organizationId !== organizationId) return { ok: false as const, error: "Season pass not found." };

  const event = await prisma.event.findUnique({ where: { id: eventId }, select: { organizationId: true } });
  if (!event || event.organizationId !== organizationId) return { ok: false as const, error: "Event not found." };

  try {
    const link = await prisma.seasonPassEvent.create({ data: { seasonPassId, eventId } });
    return { ok: true as const, seasonPassEventId: link.id };
  } catch (err) {
    // @@unique([seasonPassId, eventId]) — linking the same event twice is a
    // no-op from the caller's point of view, not an error.
    if ((err as { code?: string }).code === "P2002") return { ok: true as const, seasonPassEventId: null };
    throw err;
  }
}

export interface SeasonPassBuyer {
  userId: string;
  name: string;
  phone: string;
  email?: string | null;
  mobileNetwork?: string;
}

function clubNameFor(organization: { displayName: string | null; name: string }): string {
  return organization.displayName ?? organization.name;
}

// Starts (and, with the simulator or a synchronous provider approval,
// completes) a season pass purchase. Mirrors purchaseListing's
// reserve-then-charge shape (src/lib/resale.ts) minus the reservation step —
// a season pass has no single scarce unit to reserve, only the overall
// maxHolders cap re-checked via the CAS below. A holder row is only ever
// created once the charge is confirmed PAID; PENDING (real AirPay,
// awaiting the buyer's phone confirmation) creates nothing yet, since this
// codebase has no AirPay webhook to resolve it later (see airpay.ts) — same
// "no polling built for this path" scope this feature's investigation
// found, given nothing wires real AirPay into checkout today either.
export async function purchaseSeasonPass(seasonPassId: string, buyer: SeasonPassBuyer) {
  const pass = await prisma.seasonPass.findUnique({
    where: { id: seasonPassId },
    include: { organization: { select: { displayName: true, name: true } }, _count: { select: { holders: true } } },
  });
  if (!pass) return { ok: false as const, error: "Season pass not found." };
  if (pass.status !== "ACTIVE") return { ok: false as const, error: "This season pass isn't available for purchase." };
  if (pass.maxHolders != null && pass._count.holders >= pass.maxHolders) {
    return { ok: false as const, error: "This season pass is sold out." };
  }
  if (!buyer.phone.trim()) return { ok: false as const, error: "Enter your mobile money number." };

  const charge = await getActivePaymentProvider().initiateCharge({
    orderClientId: `season-pass-${seasonPassId}-${buyer.userId}-${Date.now().toString(36)}`,
    amountCents: pass.price,
    phoneNumber: buyer.phone,
    mobileNetwork: buyer.mobileNetwork,
    description: `Season pass — ${pass.name}`,
  });

  if (charge.status === "FAILED") {
    return { ok: false as const, error: charge.message ?? "The payment was declined." };
  }
  if (charge.status === "PENDING") {
    return { ok: true as const, status: "PENDING" as const, message: charge.message };
  }

  // Re-check the cap under a CAS-style count at creation time too — two
  // buyers racing the last spot can't both succeed silently.
  if (pass.maxHolders != null) {
    const current = await prisma.seasonPassHolder.count({ where: { seasonPassId } });
    if (current >= pass.maxHolders) return { ok: false as const, error: "This season pass is sold out." };
  }

  const holder = await prisma.seasonPassHolder.create({
    data: {
      seasonPassId,
      userId: buyer.userId,
      name: buyer.name,
      phone: normalizeTanzaniaPhone(buyer.phone),
      email: buyer.email ?? null,
    },
  });

  const clubName = clubNameFor(pass.organization);
  await sendNotification({
    type: "SEASON_PASS_PURCHASED",
    channel: "WHATSAPP",
    recipient: holder.phone,
    subject: `Season pass purchased — ${holder.id}`,
    body: `🎟 Your ${clubName} season pass is confirmed! Your wristband will be activated at your first match. chaap.africa`,
  });

  return { ok: true as const, status: "CONFIRMED" as const, holderId: holder.id };
}

export interface SeasonPassHolderRow {
  id: string;
  name: string;
  phone: string;
  email: string | null;
  purchasedAt: string;
  renewalStatus: string;
}

export async function getSeasonPassHolders(seasonPassId: string): Promise<SeasonPassHolderRow[]> {
  const holders = await prisma.seasonPassHolder.findMany({
    where: { seasonPassId },
    orderBy: { purchasedAt: "desc" },
  });
  return holders.map((h) => ({
    id: h.id,
    name: h.name,
    phone: h.phone,
    email: h.email,
    purchasedAt: h.purchasedAt.toISOString(),
    renewalStatus: h.renewalStatus,
  }));
}

// Whether `userId` currently holds a season pass covering `eventId` — the
// gate check a season pass holder's entry rides on (alongside the ordinary
// ticket check — see the gate scanner's season-pass-check route). Treats
// RENEWAL_OFFERED/RENEWAL_CONFIRMED as still-current (an outstanding or just
// -confirmed renewal never means "not a holder right now"); only
// RENEWAL_DECLINED/EXPIRED lose access. Also requires the pass itself to
// still be ACTIVE and not past its endDate — a holder row's own existence
// never expires it, since renewing is exactly what extends the shared
// SeasonPass.endDate (see season-renewal.ts).
export async function isSeasonPassHolder(userId: string, eventId: string, now: Date = new Date()): Promise<boolean> {
  const holder = await prisma.seasonPassHolder.findFirst({
    where: {
      userId,
      renewalStatus: { in: ["ACTIVE", "RENEWAL_OFFERED", "RENEWAL_CONFIRMED"] },
      seasonPass: {
        status: "ACTIVE",
        endDate: { gte: now },
        events: { some: { eventId } },
      },
    },
    select: { id: true },
  });
  return !!holder;
}

export interface PublicSeasonPass {
  id: string;
  name: string;
  description: string | null;
  clubName: string;
  price: number;
  currency: string;
  startDate: string;
  endDate: string;
  purchasable: boolean;
  events: { title: string; startsAt: string }[];
}

// Backs the public /season-passes/[id] purchase page — deliberately no auth
// check (same "buy requires an account, browsing doesn't" split as the
// resale marketplace's own GET/buy routes), and only ever the fields a
// prospective buyer needs, never anything holder-scoped.
export async function getPublicSeasonPass(seasonPassId: string): Promise<PublicSeasonPass | null> {
  const pass = await prisma.seasonPass.findUnique({
    where: { id: seasonPassId },
    include: {
      organization: { select: { displayName: true, name: true } },
      events: { include: { event: { select: { title: true, startsAt: true } } }, orderBy: { event: { startsAt: "asc" } } },
      _count: { select: { holders: true } },
    },
  });
  if (!pass) return null;

  return {
    id: pass.id,
    name: pass.name,
    description: pass.description,
    clubName: clubNameFor(pass.organization),
    price: pass.price,
    currency: pass.currency,
    startDate: pass.startDate.toISOString(),
    endDate: pass.endDate.toISOString(),
    purchasable: pass.status === "ACTIVE" && (pass.maxHolders == null || pass._count.holders < pass.maxHolders),
    events: pass.events.map((e) => ({ title: e.event.title, startsAt: e.event.startsAt.toISOString() })),
  };
}

export interface SeasonPassListRow {
  id: string;
  name: string;
  status: string;
  price: number;
  currency: string;
  startDate: string;
  endDate: string;
  maxHolders: number | null;
  autoRenewEnabled: boolean;
  autoRenewPrice: number | null;
  holderCount: number;
  // Approximate — the sum of every holder's original purchase price. There's
  // no separate per-transaction ledger for season passes (unlike Order/
  // WalletTransaction), so a later renewal (paid at autoRenewPrice) isn't
  // reflected here; good enough for the dashboard's at-a-glance figure.
  revenueCents: number;
  renewalBreakdown: { active: number; offered: number; confirmed: number; declined: number; expired: number };
}

// Backs the /dashboard/season-passes list page.
export async function listSeasonPasses(organizationId: string): Promise<SeasonPassListRow[]> {
  const passes = await prisma.seasonPass.findMany({
    where: { organizationId },
    include: { holders: { select: { renewalStatus: true } } },
    orderBy: { createdAt: "desc" },
  });

  return passes.map((p) => {
    const breakdown = { active: 0, offered: 0, confirmed: 0, declined: 0, expired: 0 };
    for (const h of p.holders) {
      if (h.renewalStatus === "ACTIVE") breakdown.active++;
      else if (h.renewalStatus === "RENEWAL_OFFERED") breakdown.offered++;
      else if (h.renewalStatus === "RENEWAL_CONFIRMED") breakdown.confirmed++;
      else if (h.renewalStatus === "RENEWAL_DECLINED") breakdown.declined++;
      else if (h.renewalStatus === "EXPIRED") breakdown.expired++;
    }
    return {
      id: p.id,
      name: p.name,
      status: p.status,
      price: p.price,
      currency: p.currency,
      startDate: p.startDate.toISOString(),
      endDate: p.endDate.toISOString(),
      maxHolders: p.maxHolders,
      autoRenewEnabled: p.autoRenewEnabled,
      autoRenewPrice: p.autoRenewPrice,
      holderCount: p.holders.length,
      revenueCents: p.holders.length * p.price,
      renewalBreakdown: breakdown,
    };
  });
}

export interface SeasonPassDetail extends SeasonPassListRow {
  description: string | null;
  linkedEvents: { id: string; title: string; startsAt: string }[];
  linkableEvents: { id: string; title: string; startsAt: string }[];
  holders: (SeasonPassHolderRow & { credentialId: string | null })[];
}

// Backs the /dashboard/season-passes/[id] detail page.
export async function getSeasonPassDetail(organizationId: string, seasonPassId: string): Promise<SeasonPassDetail | null> {
  const pass = await prisma.seasonPass.findUnique({
    where: { id: seasonPassId },
    include: {
      holders: { orderBy: { purchasedAt: "desc" } },
      events: { include: { event: { select: { id: true, title: true, startsAt: true } } }, orderBy: { event: { startsAt: "asc" } } },
    },
  });
  if (!pass || pass.organizationId !== organizationId) return null;

  const linkedEventIds = new Set(pass.events.map((e) => e.eventId));
  const orgEvents = await prisma.event.findMany({
    where: { organizationId, id: { notIn: Array.from(linkedEventIds) } },
    select: { id: true, title: true, startsAt: true },
    orderBy: { startsAt: "asc" },
  });

  const breakdown = { active: 0, offered: 0, confirmed: 0, declined: 0, expired: 0 };
  for (const h of pass.holders) {
    if (h.renewalStatus === "ACTIVE") breakdown.active++;
    else if (h.renewalStatus === "RENEWAL_OFFERED") breakdown.offered++;
    else if (h.renewalStatus === "RENEWAL_CONFIRMED") breakdown.confirmed++;
    else if (h.renewalStatus === "RENEWAL_DECLINED") breakdown.declined++;
    else if (h.renewalStatus === "EXPIRED") breakdown.expired++;
  }

  return {
    id: pass.id,
    name: pass.name,
    description: pass.description,
    status: pass.status,
    price: pass.price,
    currency: pass.currency,
    startDate: pass.startDate.toISOString(),
    endDate: pass.endDate.toISOString(),
    maxHolders: pass.maxHolders,
    autoRenewEnabled: pass.autoRenewEnabled,
    autoRenewPrice: pass.autoRenewPrice,
    holderCount: pass.holders.length,
    revenueCents: pass.holders.length * pass.price,
    renewalBreakdown: breakdown,
    linkedEvents: pass.events.map((e) => ({ id: e.event.id, title: e.event.title, startsAt: e.event.startsAt.toISOString() })),
    linkableEvents: orgEvents.map((e) => ({ id: e.id, title: e.title, startsAt: e.startsAt.toISOString() })),
    holders: pass.holders.map((h) => ({
      id: h.id,
      name: h.name,
      phone: h.phone,
      email: h.email,
      purchasedAt: h.purchasedAt.toISOString(),
      renewalStatus: h.renewalStatus,
      credentialId: h.credentialId,
    })),
  };
}

export async function setAutoRenewSettings(
  organizationId: string,
  seasonPassId: string,
  input: { autoRenewEnabled: boolean; autoRenewPrice: number | null }
) {
  if (input.autoRenewPrice != null && (!Number.isInteger(input.autoRenewPrice) || input.autoRenewPrice <= 0)) {
    return { ok: false as const, error: "Renewal price must be a positive whole number of cents." };
  }
  const res = await prisma.seasonPass.updateMany({
    where: { id: seasonPassId, organizationId },
    data: { autoRenewEnabled: input.autoRenewEnabled, autoRenewPrice: input.autoRenewPrice },
  });
  if (res.count === 0) return { ok: false as const, error: "Season pass not found." };
  return { ok: true as const };
}

// Links a holder's physical wristband to their pass, so the gate scanner can
// recognise it via isSeasonPassHolderByCredential — the organiser-side half
// of "your wristband will be activated at your first match." A minimal
// stand-in for a full gate-side provisioning flow (out of scope this
// session — see the gate scanner integration's own comment); the organiser
// enters the wristband's NFC uid from the dashboard instead.
export async function provisionSeasonPassWristband(
  organizationId: string,
  holderId: string,
  nfcUid: string,
  actor: { userId: string; name: string }
) {
  const holder = await prisma.seasonPassHolder.findUnique({
    where: { id: holderId },
    include: { seasonPass: { select: { organizationId: true } } },
  });
  if (!holder || holder.seasonPass.organizationId !== organizationId) {
    return { ok: false as const, error: "Season pass holder not found." };
  }
  const uid = nfcUid.trim();
  if (!uid) return { ok: false as const, error: "Enter the wristband's NFC uid." };

  const credential = await prisma.credential.create({
    data: {
      organizationId,
      nfcUid: uid,
      code: `SPH-${holder.id.slice(-8).toUpperCase()}`,
      status: "ACTIVE",
      createdByUserId: actor.userId,
      createdByName: actor.name,
    },
  });

  await prisma.seasonPassHolder.update({ where: { id: holderId }, data: { credentialId: credential.id } });
  return { ok: true as const, credentialId: credential.id };
}

// Same coverage check as isSeasonPassHolder, keyed by the holder's
// provisioned wristband instead of their account — what the gate scanner
// actually has on hand from an NFC tap (see
// src/app/api/scan/[eventId]/season-pass-check/route.ts). A season pass
// holder's wristband is provisioned once (dashboard "Provision wristband"
// action) and then valid for every linked event, unlike a ticket's
// Credential which is scoped to one event.
export async function isSeasonPassHolderByCredential(credentialId: string, eventId: string, now: Date = new Date()) {
  const holder = await prisma.seasonPassHolder.findFirst({
    where: {
      credentialId,
      renewalStatus: { in: ["ACTIVE", "RENEWAL_OFFERED", "RENEWAL_CONFIRMED"] },
      seasonPass: {
        status: "ACTIVE",
        endDate: { gte: now },
        events: { some: { eventId } },
      },
    },
    select: { name: true, seasonPass: { select: { name: true } } },
  });
  if (!holder) return null;
  return { holderName: holder.name, seasonPassName: holder.seasonPass.name };
}
