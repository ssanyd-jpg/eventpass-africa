import { NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/auth";
import { isClaudeConfigured } from "@/lib/ai/claude";
import { summarizeSurveyTheme } from "@/lib/ai/survey-summary";
import { getSurveyEvent, getSurveyResults } from "@/lib/survey-handlers";

const bodySchema = z.object({ eventId: z.string().min(1), questionId: z.string().min(1) });

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

  const event = await getSurveyEvent(session.user.organizationId, parsed.data.eventId);
  if (!event) {
    return NextResponse.json({ ok: false, reason: "NOT_FOUND" }, { status: 404 });
  }

  const results = (await getSurveyResults(session.user.organizationId, parsed.data.eventId)) ?? [];
  const row = results.find((r) => r.questionId === parsed.data.questionId);
  if (!row) {
    return NextResponse.json({ ok: false, reason: "NOT_FOUND" }, { status: 404 });
  }

  const result = await summarizeSurveyTheme(row.label, row.values);
  if (!result.ok) {
    const status = result.reason === "TOO_FEW_RESPONSES" ? 422 : 502;
    return NextResponse.json({ ok: false, reason: result.reason, message: result.message }, { status });
  }
  return NextResponse.json({ ok: true, summary: result.summary });
}
