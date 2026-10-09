import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { checkRateLimit, clientIp } from "@/lib/rate-limit";
import { sendNotification } from "@/lib/notifications";

/**
 * Public, unauthenticated contact-form endpoint for the chaap.africa
 * marketing site — that site is a separate static page, not part of this
 * repo (yet), so every request here is genuinely cross-origin and needs its
 * own CORS allow-list rather than relying on this app's own session/CSRF
 * story.
 *
 * DEV-ONLY: while the marketing site is still hosted as a Claude Artifact,
 * its live preview renders the artboard in an iframe built from a `data:`
 * URL rather than serving it from a real https:// origin. A document loaded
 * from a `data:` URL (without `allow-same-origin` in its sandbox) has an
 * opaque origin, which browsers serialize in the fetch `Origin` header as
 * the literal string "null" — not a domain. That's what shows up here, so
 * it's allow-listed by that literal string rather than a guessed subdomain.
 * Remove the "null" entry once chaap.africa itself is serving this form and
 * the Artifact preview is no longer in the loop.
 */
const ALLOWED_ORIGINS = new Set(["https://chaap.africa", "https://www.chaap.africa", "null"]);

function allowedOrigin(origin: string | null): string | null {
  return origin && ALLOWED_ORIGINS.has(origin) ? origin : null;
}

function withCors(origin: string | null, body: unknown, status: number) {
  const allowed = allowedOrigin(origin);
  return NextResponse.json(body, {
    status,
    headers: allowed ? { "Access-Control-Allow-Origin": allowed, Vary: "Origin" } : {},
  });
}

function emptyToUndefined(value: unknown) {
  return typeof value === "string" && value.trim() === "" ? undefined : value;
}

// A missing key arrives as `undefined`, same as an explicit "" after
// emptyToUndefined — coercing both to "" here (rather than leaving
// `undefined`) means a required field's own .min(1, "...") message always
// fires, instead of zod's generic "Required" for the "key absent entirely"
// case.
function missingToEmptyString(value: unknown) {
  return typeof value === "string" ? value : "";
}

const leadSchema = z.object({
  name: z.preprocess(missingToEmptyString, z.string().trim().min(1, "Name is required")),
  phone: z.preprocess(missingToEmptyString, z.string().trim().min(1, "Phone is required")),
  email: z.preprocess(emptyToUndefined, z.string().trim().email("Enter a valid email").optional()),
  eventName: z.preprocess(emptyToUndefined, z.string().trim().optional()),
  expectedAttendance: z.preprocess(emptyToUndefined, z.string().trim().optional()),
});

export async function OPTIONS(request: Request) {
  const allowed = allowedOrigin(request.headers.get("origin"));
  if (!allowed) {
    return new NextResponse(null, { status: 403 });
  }
  return new NextResponse(null, {
    status: 204,
    headers: {
      "Access-Control-Allow-Origin": allowed,
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
      Vary: "Origin",
    },
  });
}

export async function POST(request: Request) {
  const origin = request.headers.get("origin");
  // Only enforced when an Origin header is actually present — a browser
  // cross-origin fetch always sends one; a same-origin or server-to-server
  // call (curl, a future internal tool) sends none and isn't a CORS
  // concern, so it isn't blocked here.
  if (origin && !allowedOrigin(origin)) {
    return NextResponse.json({ error: "Origin not allowed" }, { status: 403 });
  }

  const { allowed: rateLimitAllowed } = await checkRateLimit(`leads:${clientIp(request)}`, {
    limit: 5,
    windowMs: 60 * 60 * 1000,
  });
  if (!rateLimitAllowed) {
    return withCors(origin, { error: "Too many submissions. Try again later." }, 429);
  }

  const body = await request.json().catch(() => null);
  const parsed = leadSchema.safeParse(body);
  if (!parsed.success) {
    const message = parsed.error.issues[0]?.message ?? "Invalid input";
    return withCors(origin, { error: message }, 400);
  }

  const { name, phone, email, eventName, expectedAttendance } = parsed.data;

  try {
    const lead = await prisma.marketingLead.create({
      data: { name, phone, email, eventName, expectedAttendance },
    });

    // Notification failures must never turn a successfully-captured lead
    // into an error response — the lead is already recorded regardless of
    // whether hello@chaap.africa or the owner's phone actually got pinged.
    try {
      const summary =
        `New lead from chaap.africa\n\n` +
        `Name: ${name}\nPhone: ${phone}\n` +
        (email ? `Email: ${email}\n` : "") +
        (eventName ? `Event: ${eventName}\n` : "") +
        (expectedAttendance ? `Expected attendance: ${expectedAttendance}\n` : "");

      await sendNotification({
        type: "MARKETING_LEAD_RECEIVED",
        channel: "EMAIL",
        recipient: "hello@chaap.africa",
        subject: `New lead: ${name}`,
        body: summary,
      });

      const ownerPhone = process.env.CHAAP_OWNER_PHONE;
      if (ownerPhone) {
        await sendNotification({
          type: "MARKETING_LEAD_RECEIVED",
          channel: "WHATSAPP",
          recipient: ownerPhone,
          subject: `New lead: ${name}`,
          body: `New Chaap lead: ${name}, ${phone}${eventName ? ` — ${eventName}` : ""}`,
        });
      } else {
        console.warn("[leads] CHAAP_OWNER_PHONE is not set — skipping the owner WhatsApp notification");
      }
    } catch (err) {
      console.error("[leads] notification failed for lead", lead.id, err);
    }

    return withCors(origin, { id: lead.id }, 201);
  } catch (err) {
    console.error("[leads] unexpected error", err);
    return withCors(origin, { error: "Something went wrong. Please try again." }, 500);
  }
}
