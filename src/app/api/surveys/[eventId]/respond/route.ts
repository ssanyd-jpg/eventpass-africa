import { NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/auth";
import { submitSurveyResponses } from "@/lib/survey-handlers";

const respondSchema = z.object({
  answers: z.array(z.object({ questionId: z.string().min(1), value: z.string().max(2000) })),
});

// Plain session-authenticated route, not queueOp — a survey only exists
// after the event has ended, so there's no offline/at-the-venue story
// (same reasoning as ticket-transfer initiation and support tickets).
export async function POST(request: Request, { params }: { params: { eventId: string } }) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ ok: false, error: "Sign in required." }, { status: 401 });
  }

  const parsed = respondSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ ok: false, error: "Invalid request." }, { status: 400 });
  }

  const result = await submitSurveyResponses(session.user.id, params.eventId, parsed.data.answers);
  return NextResponse.json({ ok: true, ...result });
}
