import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { checkRateLimit, clientIp } from "@/lib/rate-limit";
import { sendNotification } from "@/lib/notifications";
import { generateSponsorMagicLink } from "@/lib/sponsor-auth";

const requestSchema = z.object({ email: z.string().email(), eventCode: z.string().min(1) });

// Same anti-enumeration discipline as the vendor magic-link request route:
// one generic response regardless of whether the event/sponsor/email
// combination actually matches anything.
export async function POST(request: Request) {
  const { allowed } = await checkRateLimit(`sponsor-magic-link:${clientIp(request)}`, {
    limit: 5,
    windowMs: 10 * 60 * 1000,
  });
  const generic = NextResponse.json({ ok: true });
  if (!allowed) return generic;

  const parsed = requestSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return generic;

  // Second bucket, keyed by the target email rather than the caller's IP —
  // catches a single sponsor inbox being hammered from many different IPs,
  // which the IP-keyed check above can't see.
  const emailLimit = await checkRateLimit(`sponsor-magic-link-email:${parsed.data.email.toLowerCase()}`, {
    limit: 3,
    windowMs: 60 * 60 * 1000,
  });
  if (!emailLimit.allowed) return generic;

  // "Event code" is the event's existing public slug — same convention as
  // the vendor magic-link request route.
  const event = await prisma.event.findUnique({ where: { slug: parsed.data.eventCode.trim().toLowerCase() } });
  if (!event) return generic;

  // No status field to filter on (unlike Vendor) — every sponsor on this
  // event is a valid login target.
  const sponsor = await prisma.sponsor.findFirst({
    where: { eventId: event.id, contactEmail: { equals: parsed.data.email, mode: "insensitive" } },
  });
  if (!sponsor) return generic;

  const rawToken = await generateSponsorMagicLink(sponsor.id);
  const verifyUrl = `${process.env.NEXTAUTH_URL ?? ""}/sponsor/verify/${rawToken}`;
  await sendNotification({
    type: "SPONSOR_MAGIC_LINK",
    channel: "EMAIL",
    recipient: sponsor.contactEmail,
    subject: "Your Chaap sponsor portal link",
    body: `Hi ${sponsor.name}, here's your sign-in link for the sponsor portal (expires in 24 hours or on first use): ${verifyUrl}`,
  });

  return generic;
}
