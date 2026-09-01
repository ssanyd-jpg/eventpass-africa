import { prisma } from "@/lib/prisma";
import { buildCsvDocument } from "@/lib/csv";

// Business logic behind the survey-response submission route and the
// organizer-facing results page/export — extracted for direct testability,
// same reasoning as sponsor-leads.ts.

// Scoped by organizationId (via event -> organization), not just eventId —
// same cross-org guard discipline as every other dashboard detail query.
export async function getSurveyEvent(organizationId: string, eventId: string) {
  return prisma.event.findFirst({ where: { id: eventId, organizationId } });
}

export async function getSurveyQuestions(eventId: string) {
  return prisma.surveyQuestion.findMany({ where: { eventId }, orderBy: { sortOrder: "asc" } });
}

// Submission is buyer-initiated, session-authenticated, and silently drops
// any answer referencing a question from a different event — same
// defensive-against-a-stale/tampered-client discipline handleSellTickets
// already uses for registration answers.
export async function submitSurveyResponses(
  buyerUserId: string,
  eventId: string,
  answers: Array<{ questionId: string; value: string }>
) {
  const validQuestionIds = new Set(
    (await prisma.surveyQuestion.findMany({ where: { eventId }, select: { id: true } })).map((q) => q.id)
  );
  const validAnswers = answers.filter((a) => validQuestionIds.has(a.questionId));

  await prisma.$transaction(
    validAnswers.map((a) =>
      prisma.surveyResponse.upsert({
        where: { questionId_buyerUserId: { questionId: a.questionId, buyerUserId } },
        create: { questionId: a.questionId, buyerUserId, value: a.value },
        update: { value: a.value },
      })
    )
  );

  return { savedCount: validAnswers.length };
}

export const SURVEY_ELIGIBLE_HOURS = 24;

export interface PendingSurvey {
  eventId: string;
  eventClientId: string | null;
  eventTitle: string;
  questions: Array<{
    id: string;
    clientId: string | null;
    label: string;
    type: string;
    options: string | null;
    required: boolean;
  }>;
}

// Lazy survey-invitation trigger — this codebase has no background job
// runner, so this piggybacks on the periodic pull poll every online client
// already makes (startAutoSync's 20s interval in sync-engine.ts). "24h past
// startsAt" approximates "the event has ended" — Event has no endsAt field,
// so this is a deliberate over-approximation (correct for a single-day
// event, early for a multi-day one), not a real signal. Note: a buyer who
// partially answers (some but not all questions) already has a
// SurveyResponse row and won't be re-prompted — matches this feature's
// flat, no-branching-logic scope.
export async function getPendingSurveysForBuyer(
  userId: string,
  hoursThreshold: number = SURVEY_ELIGIBLE_HOURS
): Promise<PendingSurvey[]> {
  const cutoff = new Date(Date.now() - hoursThreshold * 60 * 60 * 1000);
  const completedOrderEvents = await prisma.order.findMany({
    where: { userId, status: { in: ["PAID", "NEEDS_REVIEW"] }, event: { startsAt: { lt: cutoff } } },
    select: {
      event: {
        select: { id: true, clientId: true, title: true, surveyQuestions: { orderBy: { sortOrder: "asc" } } },
      },
    },
    distinct: ["eventId"],
  });
  const eventsWithQuestions = completedOrderEvents.map((o) => o.event).filter((e) => e.surveyQuestions.length > 0);
  if (eventsWithQuestions.length === 0) return [];

  const myResponses = await prisma.surveyResponse.findMany({
    where: { buyerUserId: userId, question: { eventId: { in: eventsWithQuestions.map((e) => e.id) } } },
    select: { question: { select: { eventId: true } } },
  });
  const respondedEventIds = new Set(myResponses.map((r) => r.question.eventId));

  return eventsWithQuestions
    .filter((e) => !respondedEventIds.has(e.id))
    .map((e) => ({
      eventId: e.id,
      eventClientId: e.clientId,
      eventTitle: e.title,
      questions: e.surveyQuestions.map((q) => ({
        id: q.id,
        clientId: q.clientId,
        label: q.label,
        type: q.type,
        options: q.options,
        required: q.required,
      })),
    }));
}

export interface SurveyResultRow {
  questionId: string;
  label: string;
  type: string;
  options: string | null;
  // For TEXT: every free-text value, newest first. For SELECT/CHECKBOX:
  // tallied counts per option value.
  values: string[];
  tally: Record<string, number>;
}

export async function getSurveyResults(organizationId: string, eventId: string): Promise<SurveyResultRow[] | null> {
  const event = await getSurveyEvent(organizationId, eventId);
  if (!event) return null;

  const questions = await prisma.surveyQuestion.findMany({
    where: { eventId },
    orderBy: { sortOrder: "asc" },
    include: { responses: { orderBy: { createdAt: "desc" } } },
  });

  return questions.map((q) => {
    const values = q.responses.map((r) => r.value);
    const tally: Record<string, number> = {};
    for (const v of values) tally[v] = (tally[v] ?? 0) + 1;
    return { questionId: q.id, label: q.label, type: q.type, options: q.options, values, tally };
  });
}

export function buildSurveyResultsCsv(eventTitle: string, results: SurveyResultRow[]): string {
  return buildCsvDocument(
    results.map((r) => ({
      title: `${r.label} (${eventTitle})`,
      headers: r.type === "TEXT" ? ["Response"] : ["Option", "Count"],
      rows:
        r.type === "TEXT"
          ? r.values.map((v) => [v])
          : Object.entries(r.tally).map(([option, count]) => [option, count]),
    }))
  );
}
