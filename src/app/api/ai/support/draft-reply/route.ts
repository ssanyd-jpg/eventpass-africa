import { NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/auth";
import { isClaudeConfigured } from "@/lib/ai/claude";
import { draftSupportReply } from "@/lib/ai/support-assist";
import { getSupportTicketDetailForOrg } from "@/lib/support-handlers";

const bodySchema = z.object({ ticketId: z.string().min(1) });

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

  const result = await draftSupportReply(detail.ticket, detail.replies);
  if (!result.ok) {
    return NextResponse.json({ ok: false, reason: result.reason, message: result.message }, { status: 502 });
  }
  return NextResponse.json({ ok: true, draft: result.draft });
}
