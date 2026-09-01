import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { getSurveyEvent, getSurveyResults, buildSurveyResultsCsv } from "@/lib/survey-handlers";
import { slugify } from "@/lib/format";

// Mirrors the sponsor-leads export route exactly — session-authenticated,
// GATE_CREW blocked, org-scoped lookup, text/csv attachment.
export async function GET(_request: Request, { params }: { params: { id: string } }) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ ok: false, reason: "UNAUTHENTICATED" }, { status: 401 });
  }
  if (session.user.organizationRole === "GATE_CREW") {
    return NextResponse.json({ ok: false, reason: "FORBIDDEN" }, { status: 403 });
  }

  const event = await getSurveyEvent(session.user.organizationId, params.id);
  if (!event) {
    return NextResponse.json({ ok: false, reason: "NOT_FOUND" }, { status: 404 });
  }

  const results = (await getSurveyResults(session.user.organizationId, params.id)) ?? [];
  const csv = buildSurveyResultsCsv(event.title, results);
  const filename = `survey-results-${slugify(event.title)}.csv`;

  return new NextResponse(csv, {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="${filename}"`,
    },
  });
}
