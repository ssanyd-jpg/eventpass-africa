import { createHash, randomBytes } from "crypto";
import { prisma } from "@/lib/prisma";
import { sendNotification } from "@/lib/notifications";

const TOKEN_TTL_MS = 24 * 60 * 60 * 1000; // 24h — see VendorMagicLinkToken in schema.prisma

// Same raw-token/tokenHash split as password-reset/request's route: the raw
// token only ever exists in the emailed URL and briefly in memory here;
// only its sha256 hash is persisted, so a DB read alone can never produce a
// usable login link.
export async function generateVendorMagicLink(vendorId: string): Promise<string> {
  const rawToken = randomBytes(32).toString("hex");
  const tokenHash = createHash("sha256").update(rawToken).digest("hex");

  await prisma.vendorMagicLinkToken.create({
    data: { tokenHash, vendorId, expiresAt: new Date(Date.now() + TOKEN_TTL_MS) },
  });

  return rawToken;
}

export type ConsumeVendorMagicLinkResult =
  | { ok: true; vendor: { id: string; name: string; contactEmail: string; eventId: string } }
  | { ok: false; reason: "INVALID_OR_EXPIRED" };

// Validates + immediately marks the token used, in one transaction — a
// token is single-use "whichever comes first" (24h OR first use), so the
// used/expiry check and the used-marking must be atomic or two concurrent
// requests with the same link could both succeed.
export async function consumeVendorMagicLinkToken(rawToken: string): Promise<ConsumeVendorMagicLinkResult> {
  const tokenHash = createHash("sha256").update(rawToken).digest("hex");

  return prisma.$transaction(async (tx) => {
    const token = await tx.vendorMagicLinkToken.findUnique({
      where: { tokenHash },
      include: { vendor: { select: { id: true, name: true, contactEmail: true, eventId: true, status: true } } },
    });

    if (!token || token.usedAt || token.expiresAt < new Date() || token.vendor.status !== "APPROVED") {
      return { ok: false, reason: "INVALID_OR_EXPIRED" as const };
    }

    await tx.vendorMagicLinkToken.update({ where: { id: token.id }, data: { usedAt: new Date() } });

    return {
      ok: true as const,
      vendor: {
        id: token.vendor.id,
        name: token.vendor.name,
        contactEmail: token.vendor.contactEmail,
        eventId: token.vendor.eventId,
      },
    };
  });
}

// Kept out of dashboard/events/[id]/vendors/actions.ts, same reasoning as
// vendor-settlement.ts's header comment — every export of a "use server"
// file is a client-reachable RPC, so the organizationId-ownership check and
// the actual send happen here, and the action file just calls this after
// requireViewer().
export async function sendVendorPortalLinkCore(organizationId: string, vendorId: string) {
  const vendor = await prisma.vendor.findUnique({
    where: { id: vendorId },
    include: { event: { select: { organizationId: true } } },
  });
  if (!vendor || vendor.event.organizationId !== organizationId) {
    throw new Error("Forbidden");
  }
  if (!vendor.contactEmail) {
    throw new Error("This vendor has no contact email on file.");
  }

  const rawToken = await generateVendorMagicLink(vendor.id);
  const verifyUrl = `${process.env.NEXTAUTH_URL ?? ""}/vendor/verify/${rawToken}`;
  await sendNotification({
    type: "VENDOR_MAGIC_LINK",
    channel: "EMAIL",
    recipient: vendor.contactEmail,
    subject: "Your Chaap vendor portal link",
    body: `Hi ${vendor.name}, here's your sign-in link for the vendor portal (expires in 24 hours or on first use): ${verifyUrl}`,
  });

  return { vendorName: vendor.name, contactEmail: vendor.contactEmail };
}
