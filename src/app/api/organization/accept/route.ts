import { NextResponse } from "next/server";
import { createHash } from "crypto";
import { z } from "zod";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";

const acceptSchema = z.object({ token: z.string().min(1) });

// Requires the visitor to already be signed in with an email matching the
// invite. Blocks (rather than transferring) if the invitee's own personal
// organization currently owns any events — no orphan-avoidance transfer
// flow in v1, just a clear refusal.
export async function POST(request: Request) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ ok: false, error: "Sign in to accept this invite." }, { status: 401 });
  }

  const parsed = acceptSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ ok: false, error: "Invalid request." }, { status: 400 });
  }

  const tokenHash = createHash("sha256").update(parsed.data.token).digest("hex");
  const invite = await prisma.organizationInvite.findUnique({
    where: { tokenHash },
    include: { organization: { select: { id: true, name: true } } },
  });

  if (!invite || invite.status !== "PENDING" || invite.expiresAt < new Date()) {
    return NextResponse.json({ ok: false, error: "This invite is invalid or has expired." }, { status: 400 });
  }
  if (invite.email.toLowerCase() !== session.user.email?.toLowerCase()) {
    return NextResponse.json(
      { ok: false, error: "This invite was sent to a different email address." },
      { status: 403 }
    );
  }

  const myMembership = await prisma.organizationMembership.findUnique({ where: { userId: session.user.id } });
  if (!myMembership) {
    return NextResponse.json({ ok: false, error: "Account error — no organization found." }, { status: 500 });
  }
  if (myMembership.organizationId === invite.organizationId) {
    return NextResponse.json({ ok: true, organizationName: invite.organization.name });
  }

  const eventCount = await prisma.event.count({ where: { organizationId: myMembership.organizationId } });
  if (eventCount > 0) {
    return NextResponse.json(
      { ok: false, error: "Your organization already owns events, so accepting would orphan them. Contact support." },
      { status: 409 }
    );
  }

  const oldPersonalOrgId = myMembership.organizationId;

  await prisma.$transaction([
    prisma.organizationMembership.update({
      where: { userId: session.user.id },
      data: { organizationId: invite.organizationId, role: invite.role },
    }),
    prisma.organizationInvite.update({ where: { id: invite.id }, data: { status: "ACCEPTED", acceptedAt: new Date() } }),
    prisma.organization.delete({ where: { id: oldPersonalOrgId } }),
  ]);

  return NextResponse.json({ ok: true, organizationName: invite.organization.name });
}
