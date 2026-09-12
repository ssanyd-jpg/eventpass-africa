import { createHash, randomBytes } from "crypto";
import { prisma } from "@/lib/prisma";
import { sendNotification } from "@/lib/notifications";

const TOKEN_TTL_MS = 24 * 60 * 60 * 1000; // 24h — see SponsorMagicLinkToken in schema.prisma

// Same raw-token/tokenHash split as vendor-auth.ts's generateVendorMagicLink
// (itself following password-reset/request's own pattern): the raw token
// only ever exists in the emailed URL and briefly in memory here; only its
// sha256 hash is persisted, so a DB read alone can never produce a usable
// login link.
export async function generateSponsorMagicLink(sponsorId: string): Promise<string> {
  const rawToken = randomBytes(32).toString("hex");
  const tokenHash = createHash("sha256").update(rawToken).digest("hex");

  await prisma.sponsorMagicLinkToken.create({
    data: { tokenHash, sponsorId, expiresAt: new Date(Date.now() + TOKEN_TTL_MS) },
  });

  return rawToken;
}

export type ConsumeSponsorMagicLinkResult =
  | { ok: true; sponsor: { id: string; name: string; contactEmail: string; eventId: string } }
  | { ok: false; reason: "INVALID_OR_EXPIRED" };

// Validates + immediately marks the token used, in one transaction — same
// TOCTOU reasoning as consumeVendorMagicLinkToken. Unlike that function,
// there's no vendor.status-style gate to check here: Sponsor has no status
// field at all (every sponsor an organizer adds is immediately active — see
// the Sponsor model's own header comment), so a valid, unused, unexpired
// token is unconditionally accepted.
export async function consumeSponsorMagicLinkToken(rawToken: string): Promise<ConsumeSponsorMagicLinkResult> {
  const tokenHash = createHash("sha256").update(rawToken).digest("hex");

  return prisma.$transaction(async (tx) => {
    const token = await tx.sponsorMagicLinkToken.findUnique({
      where: { tokenHash },
      include: { sponsor: { select: { id: true, name: true, contactEmail: true, eventId: true } } },
    });

    if (!token || token.usedAt || token.expiresAt < new Date()) {
      return { ok: false, reason: "INVALID_OR_EXPIRED" as const };
    }

    await tx.sponsorMagicLinkToken.update({ where: { id: token.id }, data: { usedAt: new Date() } });

    return {
      ok: true as const,
      sponsor: {
        id: token.sponsor.id,
        name: token.sponsor.name,
        contactEmail: token.sponsor.contactEmail,
        eventId: token.sponsor.eventId,
      },
    };
  });
}

// Kept out of dashboard/events/[id]/sponsors/actions.ts, same reasoning as
// vendor-auth.ts's sendVendorPortalLinkCore — every export of a "use server"
// file is a client-reachable RPC, so the organizationId-ownership check and
// the actual send happen here, and the action file just calls this after
// requireViewer().
export async function sendSponsorPortalLinkCore(organizationId: string, sponsorId: string) {
  const sponsor = await prisma.sponsor.findUnique({
    where: { id: sponsorId },
    include: { event: { select: { organizationId: true } } },
  });
  if (!sponsor || sponsor.event.organizationId !== organizationId) {
    throw new Error("Forbidden");
  }
  if (!sponsor.contactEmail) {
    throw new Error("This sponsor has no contact email on file.");
  }

  const rawToken = await generateSponsorMagicLink(sponsor.id);
  const verifyUrl = `${process.env.NEXTAUTH_URL ?? ""}/sponsor/verify/${rawToken}`;
  await sendNotification({
    type: "SPONSOR_MAGIC_LINK",
    channel: "EMAIL",
    recipient: sponsor.contactEmail,
    subject: "Your Chaap sponsor portal link",
    body: `Hi ${sponsor.name}, here's your sign-in link for the sponsor portal (expires in 24 hours or on first use): ${verifyUrl}`,
  });

  return { sponsorName: sponsor.name, contactEmail: sponsor.contactEmail };
}
