import { NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/auth";
import { isClaudeConfigured } from "@/lib/ai/claude";
import { draftEventDescription } from "@/lib/ai/description";

const bodySchema = z.object({
  title: z.string().min(1).max(120),
  category: z.string().min(1).max(40),
  venue: z.string().min(1).max(120),
  city: z.string().min(1).max(120),
  startsAt: z.string().optional(),
});

export async function POST(request: Request) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ ok: false, reason: "UNAUTHENTICATED" }, { status: 401 });
  }
  // GATE_CREW never manages events — same deny-by-default reasoning as
  // GATE_CREW_ALLOWED_OPS in access-control.ts, applied here since this
  // route sits outside the sync/push op system.
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

  const result = await draftEventDescription(parsed.data);
  if (!result.ok) {
    return NextResponse.json({ ok: false, reason: result.reason, message: result.message }, { status: 502 });
  }
  return NextResponse.json({ ok: true, description: result.description });
}
