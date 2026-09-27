import { NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { logAudit } from "@/lib/audit";

// Session 39 — Case A organiser branding (own-brand attendee experience).
// Empty string on any field clears it back to "use Chaap's default
// branding" — same convention as leaving the field blank when never set.
const brandingSchema = z.object({
  displayName: z.string().trim().max(60).optional().or(z.literal("")),
  brandColor: z
    .string()
    .trim()
    .regex(/^#[0-9a-fA-F]{6}$/, "Brand color must be a 6-digit hex code, e.g. #FF6A00")
    .optional()
    .or(z.literal("")),
  // Populated client-side by first uploading through /api/upload (same
  // Vercel Blob store event cover photos already use) and posting the
  // resulting public URL here — this route never accepts a file directly.
  logoUrl: z.string().trim().url().optional().or(z.literal("")),
});

// OWNER-only, same shape as /api/organization/invite. Every field is
// independently nullable/clearable: an organiser can set just a display
// name, just a color, all three, or clear any one back to unset.
export async function POST(request: Request) {
  const session = await auth();
  if (!session?.user?.id || session.user.organizationRole !== "OWNER") {
    return NextResponse.json({ ok: false, error: "Forbidden" }, { status: 403 });
  }

  const parsed = brandingSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ ok: false, error: parsed.error.issues[0]?.message ?? "Invalid branding" }, { status: 400 });
  }

  const { displayName, brandColor, logoUrl } = parsed.data;
  await prisma.organization.update({
    where: { id: session.user.organizationId },
    data: {
      displayName: displayName ? displayName : null,
      brandColor: brandColor ? brandColor : null,
      logoUrl: logoUrl ? logoUrl : null,
    },
  });

  await logAudit({
    organizationId: session.user.organizationId,
    actorUserId: session.user.id,
    actorName: session.user.name ?? session.user.email ?? "Unknown",
    action: "BRANDING_UPDATED",
    summary: "Updated organisation branding",
  });

  return NextResponse.json({ ok: true });
}
