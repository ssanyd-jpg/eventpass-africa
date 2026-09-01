import { describe, expect, it } from "vitest";
import { prisma } from "@/lib/prisma";
import { createTestUser, createTestOrganization, addMembership, createTestEvent } from "@/lib/test-fixtures";
import { handleSellTickets } from "@/lib/sync-handlers";
import {
  getPendingSurveysForBuyer,
  submitSurveyResponses,
  getSurveyResults,
  buildSurveyResultsCsv,
} from "@/lib/survey-handlers";

async function newOrganizer() {
  const user = await createTestUser();
  const organization = await createTestOrganization();
  await addMembership(organization.id, user.id, "OWNER");
  return { user, organizationId: organization.id };
}

async function buyTicketForEvent(eventId: string, buyerId: string) {
  const tt = await prisma.ticketType.findFirstOrThrow({ where: { eventId } });
  return handleSellTickets(buyerId, {
    clientId: `survey-${Date.now()}-${Math.random()}`,
    eventId,
    items: [{ ticketTypeId: tt.id, quantity: 1, codes: [`SUR-${Date.now()}-${Math.random()}`] }],
  });
}

async function addSurveyQuestion(eventId: string, label = "How was it?") {
  return prisma.surveyQuestion.create({ data: { eventId, label, type: "TEXT" } });
}

async function backdateEvent(eventId: string, hoursAgo: number) {
  await prisma.event.update({ where: { id: eventId }, data: { startsAt: new Date(Date.now() - hoursAgo * 60 * 60 * 1000) } });
}

describe("getPendingSurveysForBuyer", () => {
  it("includes an event more than 24h past with questions and no response", async () => {
    const { organizationId } = await newOrganizer();
    const event = await createTestEvent(organizationId);
    await backdateEvent(event.id, 30);
    await addSurveyQuestion(event.id);
    const buyer = await createTestUser();
    await buyTicketForEvent(event.id, buyer.id);

    const pending = await getPendingSurveysForBuyer(buyer.id);
    expect(pending.map((p) => p.eventId)).toContain(event.id);
  });

  it("excludes an event less than 24h past", async () => {
    const { organizationId } = await newOrganizer();
    const event = await createTestEvent(organizationId);
    await backdateEvent(event.id, 2);
    await addSurveyQuestion(event.id);
    const buyer = await createTestUser();
    await buyTicketForEvent(event.id, buyer.id);

    const pending = await getPendingSurveysForBuyer(buyer.id);
    expect(pending.map((p) => p.eventId)).not.toContain(event.id);
  });

  it("excludes an event the buyer already responded to", async () => {
    const { organizationId } = await newOrganizer();
    const event = await createTestEvent(organizationId);
    await backdateEvent(event.id, 30);
    const question = await addSurveyQuestion(event.id);
    const buyer = await createTestUser();
    await buyTicketForEvent(event.id, buyer.id);
    await submitSurveyResponses(buyer.id, event.id, [{ questionId: question.id, value: "Great!" }]);

    const pending = await getPendingSurveysForBuyer(buyer.id);
    expect(pending.map((p) => p.eventId)).not.toContain(event.id);
  });

  it("excludes an event with zero survey questions regardless of how long past", async () => {
    const { organizationId } = await newOrganizer();
    const event = await createTestEvent(organizationId);
    await backdateEvent(event.id, 100);
    const buyer = await createTestUser();
    await buyTicketForEvent(event.id, buyer.id);

    const pending = await getPendingSurveysForBuyer(buyer.id);
    expect(pending.map((p) => p.eventId)).not.toContain(event.id);
  });
});

describe("submitSurveyResponses", () => {
  it("saves valid answers and upserts on resubmission without duplicating rows", async () => {
    const { organizationId } = await newOrganizer();
    const event = await createTestEvent(organizationId);
    const question = await addSurveyQuestion(event.id);
    const buyer = await createTestUser();

    const first = await submitSurveyResponses(buyer.id, event.id, [{ questionId: question.id, value: "Good" }]);
    expect(first.savedCount).toBe(1);

    const second = await submitSurveyResponses(buyer.id, event.id, [{ questionId: question.id, value: "Great" }]);
    expect(second.savedCount).toBe(1);

    const rows = await prisma.surveyResponse.findMany({ where: { questionId: question.id, buyerUserId: buyer.id } });
    expect(rows).toHaveLength(1);
    expect(rows[0].value).toBe("Great");
  });

  it("silently drops an answer referencing a different event's question", async () => {
    const { organizationId } = await newOrganizer();
    const event = await createTestEvent(organizationId);
    const otherEvent = await createTestEvent(organizationId);
    const foreignQuestion = await addSurveyQuestion(otherEvent.id);
    const buyer = await createTestUser();

    const result = await submitSurveyResponses(buyer.id, event.id, [{ questionId: foreignQuestion.id, value: "x" }]);
    expect(result.savedCount).toBe(0);
  });
});

describe("getSurveyResults / buildSurveyResultsCsv", () => {
  it("tallies SELECT/CHECKBOX answers and lists TEXT answers, and the CSV escapes special characters", async () => {
    const { organizationId } = await newOrganizer();
    const event = await createTestEvent(organizationId);
    const textQ = await addSurveyQuestion(event.id, "Comments?");
    const selectQ = await prisma.surveyQuestion.create({
      data: { eventId: event.id, label: "Rating", type: "SELECT", options: "Good,Bad", sortOrder: 1 },
    });
    const buyerA = await createTestUser();
    const buyerB = await createTestUser();

    await submitSurveyResponses(buyerA.id, event.id, [
      { questionId: textQ.id, value: 'Loved it, "10/10"' },
      { questionId: selectQ.id, value: "Good" },
    ]);
    await submitSurveyResponses(buyerB.id, event.id, [{ questionId: selectQ.id, value: "Good" }]);

    const results = await getSurveyResults(organizationId, event.id);
    expect(results).not.toBeNull();
    const selectResult = results!.find((r) => r.questionId === selectQ.id);
    expect(selectResult?.tally).toEqual({ Good: 2 });

    const csv = buildSurveyResultsCsv(event.title, results!);
    expect(csv).toContain('"Loved it, ""10/10"""');
    expect(csv).toContain("Good,2");
  });

  it("returns null for an event outside the caller's organization", async () => {
    const { organizationId: orgA } = await newOrganizer();
    const event = await createTestEvent(orgA);
    const { organizationId: orgB } = await newOrganizer();

    expect(await getSurveyResults(orgB, event.id)).toBeNull();
  });
});
