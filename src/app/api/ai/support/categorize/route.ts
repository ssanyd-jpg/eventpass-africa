import { NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { isClaudeConfigured } from "@/lib/ai/claude";
import { categorizeSupportTicket } from "@/lib/ai/support-assist";
import { getSupportTicketDetailForOrg } from "@/lib/support-handlers";

const bodySchema = z.object({ ticketId: z.string().min(1) });

// On-demand only — the organizer clicks "Suggest," this is never called
// automatically on ticket creation. Persists onto SupportTicket.aiCategory/
// aiPriority so the suggestion doesn't need regenerating on every view.
export async function POST(request: Request) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ ok: false, reason: "UNAUTHENTICATED" }, { status: 401 });
  }
  if (session.user.organizationRole === "GATE_CREW") {
    return NextResponse.json({ ok: false, reason: "FORBIDDEN" }, { status: 403 });
  }
  if (!isClaudeConfigured()) {
    return NextResponse.json(
      { ok: false, reason: "AI_NOT_CONFIGURED", message: "AI assist isn't set up on this deployment yet." },
      { status: 501 }
    );
  }

  const body = await request.json().catch(() => null);
  const parsed = bodySchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ ok: false, reason: "INVALID_PAYLOAD" }, { status: 400 });
  }

  let detail;
  try {
    detail = await getSupportTicketDetailForOrg(session.user.organizationId, parsed.data.ticketId);
  } catch {
    return NextResponse.json({ ok: false, reason: "NOT_FOUND" }, { status: 404 });
  }

  const result = await categorizeSupportTicket(detail.ticket.subject, detail.ticket.body);
  if (!result.ok) {
    return NextResponse.json({ ok: false, reason: result.reason, message: result.message }, { status: 502 });
  }

  await prisma.supportTicket.update({
    where: { id: detail.ticket.id },
    data: { aiCategory: result.category, aiPriority: result.priority },
  });

  return NextResponse.json({ ok: true, category: result.category, priority: result.priority });
}
