import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { checkRateLimit, clientIp } from "@/lib/rate-limit";
import { sendNotification } from "@/lib/notifications";
import { generateVendorMagicLink } from "@/lib/vendor-auth";

const requestSchema = z.object({ email: z.string().email(), eventCode: z.string().min(1) });

// Same anti-enumeration discipline as password-reset/request's route: one
// generic response regardless of whether the event/vendor/email combination
// actually matches anything, so this endpoint can never be used to probe
// which emails have vendor accounts on which events.
export async function POST(request: Request) {
  const { allowed } = await checkRateLimit(`vendor-magic-link:${clientIp(request)}`, {
    limit: 5,
    windowMs: 10 * 60 * 1000,
  });
  const generic = NextResponse.json({ ok: true });
  if (!allowed) return generic;

  const parsed = requestSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return generic;

  // Second bucket, keyed by the target email rather than the caller's IP —
  // catches a single vendor inbox being hammered from many different IPs,
  // which the IP-keyed check above can't see.
  const emailLimit = await checkRateLimit(`vendor-magic-link-email:${parsed.data.email.toLowerCase()}`, {
    limit: 3,
    windowMs: 60 * 60 * 1000,
  });
  if (!emailLimit.allowed) return generic;

  // "Event code" is the event's existing public slug (see /events/[slug]) —
  // no separate vendor-facing event-code field exists anywhere in this
  // schema, and the slug is already the human-typeable identifier this app
  // uses for an event everywhere else.
  const event = await prisma.event.findUnique({ where: { slug: parsed.data.eventCode.trim().toLowerCase() } });
  if (!event) return generic;

  const vendor = await prisma.vendor.findFirst({
    where: { eventId: event.id, status: "APPROVED", contactEmail: { equals: parsed.data.email, mode: "insensitive" } },
  });
  if (!vendor) return generic;

  const rawToken = await generateVendorMagicLink(vendor.id);
  const verifyUrl = `${process.env.NEXTAUTH_URL ?? ""}/vendor/verify/${rawToken}`;
  await sendNotification({
    type: "VENDOR_MAGIC_LINK",
    channel: "EMAIL",
    recipient: vendor.contactEmail,
    subject: "Your Chaap vendor portal link",
    body: `Hi ${vendor.name}, here's your sign-in link for the vendor portal (expires in 24 hours or on first use): ${verifyUrl}`,
  });

  return generic;
}
