/**
 * POST /api/staff/login
 *
 * Staff log in with their chaap.africa email + account password.
 * They must also specify which event they're working (eventId query param,
 * or in the request body). Returns a 12-hour signed JWT the mobile app
 * uses as a Bearer token on all subsequent /api/staff/* calls.
 *
 * Only org members (OrganizationMembership) for the event's org can log in.
 * Platform admins (User.role === "ADMIN") can log in to any event.
 */

import { NextResponse } from "next/server";
import { z } from "zod";
import bcrypt from "bcryptjs";
import { prisma } from "@/lib/prisma";
import { signStaffToken } from "@/lib/staff-token";
import { checkRateLimit, clientIp } from "@/lib/rate-limit";

const bodySchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
  eventId: z.string().min(1),
});

export async function POST(request: Request) {
  // Rate-limit: 10 attempts per 15 minutes per IP
  const { allowed } = await checkRateLimit(`staff-login:${clientIp(request)}`, {
    limit: 10,
    windowMs: 15 * 60 * 1000,
  });
  if (!allowed) {
    return NextResponse.json({ error: "Too many attempts. Try again later." }, { status: 429 });
  }

  const body = await request.json().catch(() => null);
  const parsed = bodySchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.issues[0]?.message ?? "Invalid input" }, { status: 400 });
  }

  const { email, password, eventId } = parsed.data;

  // Load user
  const user = await prisma.user.findUnique({ where: { email } });
  if (!user) {
    return NextResponse.json({ error: "Invalid credentials" }, { status: 401 });
  }

  const passwordOk = await bcrypt.compare(password, user.passwordHash);
  if (!passwordOk) {
    return NextResponse.json({ error: "Invalid credentials" }, { status: 401 });
  }

  // Load event
  const event = await prisma.event.findUnique({
    where: { id: eventId },
    select: { id: true, title: true, organizationId: true },
  });
  if (!event) {
    return NextResponse.json({ error: "Event not found" }, { status: 404 });
  }

  // Check membership — platform admins can access any event
  let role: "OWNER" | "STAFF" | "GATE_CREW" = "STAFF";
  if (user.role !== "ADMIN") {
    const membership = await prisma.organizationMembership.findFirst({
      where: { userId: user.id, organizationId: event.organizationId },
    });
    if (!membership) {
      return NextResponse.json({ error: "You are not a member of this event's organisation." }, { status: 403 });
    }
    role = membership.role as typeof role;
  }

  // If this staff member has an approved Vendor record for this event, surface
  // the vendorId so the app can pre-fill tap-to-pay without manual entry.
  const vendor = await prisma.vendor.findFirst({
    where: { eventId: event.id, ownerUserId: user.id, status: "APPROVED" },
    select: { id: true, name: true },
  });

  const token = await signStaffToken({
    userId: user.id,
    name: user.name,
    role,
    orgId: event.organizationId,
    eventId: event.id,
    eventName: event.title,
  });

  return NextResponse.json({
    token,
    name: user.name,
    role,
    eventId: event.id,
    eventName: event.title,
    vendorId: vendor?.id ?? null,
    vendorName: vendor?.name ?? null,
  });
}
