import { NextResponse } from "next/server";
import { createHash, randomBytes } from "crypto";
import { z } from "zod";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { sendNotification } from "@/lib/notifications";
import { logAudit } from "@/lib/audit";

const inviteSchema = z.object({
  email: z.string().email(),
  role: z.enum(["STAFF", "GATE_CREW"]).default("STAFF"),
});

// OWNER-only, same hashed-token + expiry shape as password-reset/request.
// Role is STAFF or GATE_CREW — never OWNER (no promote-to-owner-via-invite).
export async function POST(request: Request) {
  const session = await auth();
  if (!session?.user?.id || session.user.organizationRole !== "OWNER") {
    return NextResponse.json({ ok: false, error: "Forbidden" }, { status: 403 });
  }

  const parsed = inviteSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ ok: false, error: "Enter a valid email" }, { status: 400 });
  }

  const rawToken = randomBytes(32).toString("hex");
  const tokenHash = createHash("sha256").update(rawToken).digest("hex");

  await prisma.organizationInvite.create({
    data: {
      tokenHash,
      email: parsed.data.email,
      role: parsed.data.role,
      expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
      organizationId: session.user.organizationId,
      invitedByUserId: session.user.id,
    },
  });

  await logAudit({
    organizationId: session.user.organizationId,
    actorUserId: session.user.id,
    actorName: session.user.name ?? session.user.email ?? "Unknown",
    action: "MEMBER_INVITED",
    summary: `Invited ${parsed.data.email} as ${parsed.data.role === "GATE_CREW" ? "gate crew" : "staff"}`,
  });

  const acceptUrl = `${process.env.NEXTAUTH_URL ?? ""}/team/accept/${rawToken}`;
  await sendNotification({
    type: "ORGANIZATION_INVITE",
    channel: "EMAIL",
    recipient: parsed.data.email,
    subject: `You've been invited to join ${session.user.organizationName} on EventPass Africa`,
    body: `Hi, ${session.user.name} invited you to join ${session.user.organizationName} as a team member. Accept here (expires in 7 days): ${acceptUrl}`,
  });

  return NextResponse.json({ ok: true });
}
