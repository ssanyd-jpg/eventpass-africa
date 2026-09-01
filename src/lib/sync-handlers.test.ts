import { describe, expect, it } from "vitest";
import { prisma } from "@/lib/prisma";
import {
  createTestEvent,
  createTestUser,
  createTestOrganization,
  addMembership,
  createTestRegistrationQuestion,
  createTestDiscountCode,
  createTestSponsor,
  createTestWallet,
  createTestSponsorCampaign,
} from "@/lib/test-fixtures";
import {
  handleSellTickets,
  handleCheckIn,
  handleRefundOrder,
  handleApplyVendor,
  handleAddVendor,
  handleAddSponsor,
  handleApproveVendor,
  handleRejectVendor,
  handleCheckInVendor,
  handleEditEvent,
  handleSponsorTap,
  handleAddSponsorCampaign,
  handleDeactivateSponsorCampaign,
  payloadSchemas,
} from "@/lib/sync-handlers";

// Every "organizer" in these tests needs a real Organization + OWNER
// membership behind them now that Event/Vendor ownership checks compare
// organizationId, not a User id directly.
async function newOrganizer() {
  const user = await createTestUser();
  const organization = await createTestOrganization();
  await addMembership(organization.id, user.id, "OWNER");
  return { user, organizationId: organization.id };
}

describe("handleSellTickets", () => {
  it("creates a PAID order and increments quantitySold", async () => {
    const { organizationId } = await newOrganizer();
    const buyer = await createTestUser();
    const event = await createTestEvent(organizationId, [{ priceCents: 200000, quantityTotal: 10 }]);
    const tt = event.ticketTypes[0];

    const result = await handleSellTickets(buyer.id, {
      clientId: "client-1",
      eventId: event.id,
      items: [{ ticketTypeId: tt.id, quantity: 2, codes: ["AAAAA-11111", "BBBBB-22222"] }],
    });

    expect(result.ok).toBe(true);
    expect(result.oversold).toBe(false);
    expect(result.order.status).toBe("PAID");
    expect(result.order.totalCents).toBe(400000);
    expect(result.order.tickets.map((t: any) => t.code).sort()).toEqual(["AAAAA-11111", "BBBBB-22222"]);

    const updatedTt = await prisma.ticketType.findUniqueOrThrow({ where: { id: tt.id } });
    expect(updatedTt.quantitySold).toBe(2);
  });

  it("uses the exact client-provided ticket codes rather than generating new ones", async () => {
    const { organizationId } = await newOrganizer();
    const buyer = await createTestUser();
    const event = await createTestEvent(organizationId);
    const tt = event.ticketTypes[0];

    const result = await handleSellTickets(buyer.id, {
      clientId: "client-codes",
      eventId: event.id,
      items: [{ ticketTypeId: tt.id, quantity: 1, codes: ["MYCODE-99999"] }],
    });

    expect(result.order.tickets[0].code).toBe("MYCODE-99999");
    const stored = await prisma.ticket.findUnique({ where: { code: "MYCODE-99999" } });
    expect(stored).not.toBeNull();
  });

  it("flags the order NEEDS_REVIEW when it oversells a ticket type", async () => {
    const { organizationId } = await newOrganizer();
    const buyer = await createTestUser();
    const event = await createTestEvent(organizationId, [{ priceCents: 100000, quantityTotal: 1, quantitySold: 1 }]);
    const tt = event.ticketTypes[0];

    const result = await handleSellTickets(buyer.id, {
      clientId: "client-oversell",
      eventId: event.id,
      items: [{ ticketTypeId: tt.id, quantity: 1, codes: ["OVER-00001"] }],
    });

    expect(result.ok).toBe(true);
    expect(result.oversold).toBe(true);
    expect(result.order.status).toBe("NEEDS_REVIEW");
  });

  it("is idempotent — replaying the same clientId doesn't double-sell inventory", async () => {
    const { organizationId } = await newOrganizer();
    const buyer = await createTestUser();
    const event = await createTestEvent(organizationId, [{ priceCents: 100000, quantityTotal: 10 }]);
    const tt = event.ticketTypes[0];

    const payload = {
      clientId: "client-replay",
      eventId: event.id,
      items: [{ ticketTypeId: tt.id, quantity: 1, codes: ["REPLAY-0001"] }],
    };

    const first = await handleSellTickets(buyer.id, payload);
    const second = await handleSellTickets(buyer.id, payload);

    expect(first.order.id).toBe(second.order.id);
    const updatedTt = await prisma.ticketType.findUniqueOrThrow({ where: { id: tt.id } });
    expect(updatedTt.quantitySold).toBe(1); // not 2
  });

  it("returns retry:true when the event hasn't synced yet", async () => {
    const buyer = await createTestUser();
    const result = await handleSellTickets(buyer.id, {
      clientId: "client-no-event",
      eventId: "does-not-exist",
      items: [{ ticketTypeId: "also-fake", quantity: 1 }],
    });
    expect(result.ok).toBe(false);
    expect(result.retry).toBe(true);
  });

  it("persists registration answers and returns them on the order", async () => {
    const { organizationId } = await newOrganizer();
    const buyer = await createTestUser();
    const event = await createTestEvent(organizationId);
    const tt = event.ticketTypes[0];
    const question = await createTestRegistrationQuestion(event.id, { label: "Dietary requirements?" });

    const result = await handleSellTickets(buyer.id, {
      clientId: "client-answers",
      eventId: event.id,
      items: [{ ticketTypeId: tt.id, quantity: 1, codes: ["ANS-00001"] }],
      answers: [{ questionId: question.id, value: "Vegetarian" }],
    });

    expect(result.ok).toBe(true);
    expect(result.order.answers).toEqual([
      { questionId: question.id, questionLabel: "Dietary requirements?", value: "Vegetarian" },
    ]);
    const stored = await prisma.registrationAnswer.findMany({ where: { orderId: result.order.id } });
    expect(stored).toHaveLength(1);
  });

  it("silently drops an answer referencing a different event's question", async () => {
    const { organizationId } = await newOrganizer();
    const buyer = await createTestUser();
    const event = await createTestEvent(organizationId);
    const otherEvent = await createTestEvent(organizationId);
    const tt = event.ticketTypes[0];
    const foreignQuestion = await createTestRegistrationQuestion(otherEvent.id);

    const result = await handleSellTickets(buyer.id, {
      clientId: "client-foreign-answer",
      eventId: event.id,
      items: [{ ticketTypeId: tt.id, quantity: 1, codes: ["ANS-00002"] }],
      answers: [{ questionId: foreignQuestion.id, value: "Should be dropped" }],
    });

    expect(result.ok).toBe(true);
    expect(result.order.answers).toEqual([]);
  });

  it("rejects the sale when the event requires a waiver that wasn't accepted", async () => {
    const { organizationId } = await newOrganizer();
    const buyer = await createTestUser();
    const event = await createTestEvent(organizationId, undefined, "TZS", {}, "I agree to the terms.");
    const tt = event.ticketTypes[0];

    const result = await handleSellTickets(buyer.id, {
      clientId: "client-no-waiver",
      eventId: event.id,
      items: [{ ticketTypeId: tt.id, quantity: 1, codes: ["WAIV-00001"] }],
    });

    expect(result.ok).toBe(false);
    expect(result.reason).toBe("WAIVER_REQUIRED");
    const order = await prisma.order.findUnique({ where: { clientId: "client-no-waiver" } });
    expect(order).toBeNull();
    const updatedTt = await prisma.ticketType.findUniqueOrThrow({ where: { id: tt.id } });
    expect(updatedTt.quantitySold).toBe(0);
  });

  it("accepts the sale and snapshots the waiver text once accepted", async () => {
    const { organizationId } = await newOrganizer();
    const buyer = await createTestUser();
    const event = await createTestEvent(organizationId, undefined, "TZS", {}, "I agree to the terms.");
    const tt = event.ticketTypes[0];

    const result = await handleSellTickets(buyer.id, {
      clientId: "client-waiver-ok",
      eventId: event.id,
      items: [{ ticketTypeId: tt.id, quantity: 1, codes: ["WAIV-00002"] }],
      waiverAccepted: true,
    });

    expect(result.ok).toBe(true);
    expect(result.order.waiverText).toBe("I agree to the terms.");
    expect(result.order.waiverAcceptedAt).not.toBeNull();
  });
});

describe("handleSellTickets — discount codes", () => {
  it("applies a PERCENT_OFF code to the matching ticket type's line only", async () => {
    const { organizationId } = await newOrganizer();
    const buyer = await createTestUser();
    const event = await createTestEvent(organizationId, [{ priceCents: 100000, quantityTotal: 10 }]);
    const tt = event.ticketTypes[0];
    const code = await createTestDiscountCode(event.id, tt.id, { code: "TENOFF", type: "PERCENT_OFF", percentOff: 10 });

    const result = await handleSellTickets(buyer.id, {
      clientId: "client-discount-percent",
      eventId: event.id,
      items: [{ ticketTypeId: tt.id, quantity: 2, codes: ["DP-1", "DP-2"] }],
      discountCode: "tenoff", // lowercase — server normalizes to uppercase
    });

    expect(result.ok).toBe(true);
    // 2 * 100000 = 200000 list price, 10% off = 20000 discount
    expect(result.order.discountCents).toBe(20000);
    expect(result.order.totalCents).toBe(180000);
    expect(result.order.discountCode).toBe("TENOFF");
    expect(result.order.discountTicketTypeName).toBe(tt.name);
    expect(result.order.discountRejectReason).toBeNull();

    const updatedCode = await prisma.discountCode.findUniqueOrThrow({ where: { id: code.id } });
    expect(updatedCode.redemptionCount).toBe(1);
  });

  it("applies a FIXED_AMOUNT_OFF code, clamped so totalCents never goes negative", async () => {
    const { organizationId } = await newOrganizer();
    const buyer = await createTestUser();
    const event = await createTestEvent(organizationId, [{ priceCents: 5000, quantityTotal: 10 }]);
    const tt = event.ticketTypes[0];
    await createTestDiscountCode(event.id, tt.id, { code: "BIGOFF", type: "FIXED_AMOUNT_OFF", amountOffCents: 999999 });

    const result = await handleSellTickets(buyer.id, {
      clientId: "client-discount-fixed",
      eventId: event.id,
      items: [{ ticketTypeId: tt.id, quantity: 1, codes: ["DF-1"] }],
      discountCode: "BIGOFF",
    });

    expect(result.ok).toBe(true);
    expect(result.order.discountCents).toBe(5000); // clamped to the line total
    expect(result.order.totalCents).toBe(0);
  });

  it("soft-fails when the code targets a ticket type not present in the order — sale still completes at full price", async () => {
    const { organizationId } = await newOrganizer();
    const buyer = await createTestUser();
    const event = await createTestEvent(organizationId, [
      { priceCents: 100000, quantityTotal: 10 },
      { priceCents: 200000, quantityTotal: 10 },
    ]);
    const [general, vip] = event.ticketTypes;
    await createTestDiscountCode(event.id, vip.id, { code: "VIPONLY" });

    const result = await handleSellTickets(buyer.id, {
      clientId: "client-discount-wrong-type",
      eventId: event.id,
      items: [{ ticketTypeId: general.id, quantity: 1, codes: ["DW-1"] }],
      discountCode: "VIPONLY",
    });

    expect(result.ok).toBe(true);
    expect(result.order.discountCents).toBe(0);
    expect(result.order.totalCents).toBe(100000);
    expect(result.order.discountRejectReason).toBe("DISCOUNT_NOT_APPLICABLE");
  });

  it("soft-fails an unknown code", async () => {
    const { organizationId } = await newOrganizer();
    const buyer = await createTestUser();
    const event = await createTestEvent(organizationId, [{ priceCents: 100000, quantityTotal: 10 }]);
    const tt = event.ticketTypes[0];

    const result = await handleSellTickets(buyer.id, {
      clientId: "client-discount-unknown",
      eventId: event.id,
      items: [{ ticketTypeId: tt.id, quantity: 1, codes: ["DU-1"] }],
      discountCode: "NOPE",
    });

    expect(result.ok).toBe(true);
    expect(result.order.totalCents).toBe(100000);
    expect(result.order.discountRejectReason).toBe("DISCOUNT_NOT_FOUND");
  });

  it("soft-fails an inactive code", async () => {
    const { organizationId } = await newOrganizer();
    const buyer = await createTestUser();
    const event = await createTestEvent(organizationId, [{ priceCents: 100000, quantityTotal: 10 }]);
    const tt = event.ticketTypes[0];
    await createTestDiscountCode(event.id, tt.id, { code: "OFFCODE", active: false });

    const result = await handleSellTickets(buyer.id, {
      clientId: "client-discount-inactive",
      eventId: event.id,
      items: [{ ticketTypeId: tt.id, quantity: 1, codes: ["DI-1"] }],
      discountCode: "OFFCODE",
    });

    expect(result.order.discountRejectReason).toBe("DISCOUNT_INACTIVE");
    expect(result.order.totalCents).toBe(100000);
  });

  it("soft-fails an expired code", async () => {
    const { organizationId } = await newOrganizer();
    const buyer = await createTestUser();
    const event = await createTestEvent(organizationId, [{ priceCents: 100000, quantityTotal: 10 }]);
    const tt = event.ticketTypes[0];
    await createTestDiscountCode(event.id, tt.id, { code: "EXPIRED", expiresAt: new Date(Date.now() - 1000) });

    const result = await handleSellTickets(buyer.id, {
      clientId: "client-discount-expired",
      eventId: event.id,
      items: [{ ticketTypeId: tt.id, quantity: 1, codes: ["DE-1"] }],
      discountCode: "EXPIRED",
    });

    expect(result.order.discountRejectReason).toBe("DISCOUNT_EXPIRED");
    expect(result.order.totalCents).toBe(100000);
  });

  it("soft-fails once maxRedemptions is reached, and a concurrent race lets exactly one buyer win the last slot", async () => {
    const { organizationId } = await newOrganizer();
    const buyerA = await createTestUser();
    const buyerB = await createTestUser();
    const event = await createTestEvent(organizationId, [{ priceCents: 100000, quantityTotal: 10 }]);
    const tt = event.ticketTypes[0];
    await createTestDiscountCode(event.id, tt.id, { code: "LIMITED", maxRedemptions: 1 });

    const [resultA, resultB] = await Promise.all([
      handleSellTickets(buyerA.id, {
        clientId: "client-discount-race-a",
        eventId: event.id,
        items: [{ ticketTypeId: tt.id, quantity: 1, codes: ["DR-A"] }],
        discountCode: "LIMITED",
      }),
      handleSellTickets(buyerB.id, {
        clientId: "client-discount-race-b",
        eventId: event.id,
        items: [{ ticketTypeId: tt.id, quantity: 1, codes: ["DR-B"] }],
        discountCode: "LIMITED",
      }),
    ]);

    const outcomes = [resultA, resultB].map((r) => ({
      discounted: r.order.discountCents > 0,
      reason: r.order.discountRejectReason,
    }));
    expect(outcomes.filter((o) => o.discounted)).toHaveLength(1);
    expect(outcomes.filter((o) => o.reason === "DISCOUNT_MAX_REDEEMED")).toHaveLength(1);

    // A third attempt after both above always sees it exhausted.
    const third = await handleSellTickets(buyerA.id, {
      clientId: "client-discount-race-c",
      eventId: event.id,
      items: [{ ticketTypeId: tt.id, quantity: 1, codes: ["DR-C"] }],
      discountCode: "LIMITED",
    });
    expect(third.order.discountRejectReason).toBe("DISCOUNT_MAX_REDEEMED");
  });
});

describe("handleEditEvent — discount codes", () => {
  it("creates a discount code referencing a ticket type by its real id", async () => {
    const { user: organizer, organizationId } = await newOrganizer();
    const event = await createTestEvent(organizationId);
    const tt = event.ticketTypes[0];

    const result = await handleEditEvent(organizer.id, organizationId, {
      eventId: event.id,
      discountCodes: [{ clientId: "dc-1", code: "SAVE10", type: "PERCENT_OFF", ticketTypeId: tt.id, percentOff: 10 }],
    });

    expect(result.ok).toBe(true);
    const stored = await prisma.discountCode.findMany({ where: { eventId: event.id } });
    expect(stored).toHaveLength(1);
    expect(stored[0].code).toBe("SAVE10");
    expect(stored[0].ticketTypeId).toBe(tt.id);
  });

  it("resolves a discountCode's ticketTypeId when it references a brand-new ticket type's clientId in the same save", async () => {
    const { user: organizer, organizationId } = await newOrganizer();
    const event = await createTestEvent(organizationId);

    const result = await handleEditEvent(organizer.id, organizationId, {
      eventId: event.id,
      ticketTypes: [{ clientId: "tt-new", name: "VIP", priceCents: 500000, quantityTotal: 5 }],
      discountCodes: [{ clientId: "dc-new", code: "VIPCODE", type: "PERCENT_OFF", ticketTypeId: "tt-new", percentOff: 15 }],
    });

    expect(result.ok).toBe(true);
    const newTt = await prisma.ticketType.findUniqueOrThrow({ where: { clientId: "tt-new" } });
    const stored = await prisma.discountCode.findUniqueOrThrow({ where: { eventId_code: { eventId: event.id, code: "VIPCODE" } } });
    expect(stored.ticketTypeId).toBe(newTt.id);
  });

  it("rejects a duplicate (eventId, code) pair", async () => {
    const { user: organizer, organizationId } = await newOrganizer();
    const event = await createTestEvent(organizationId);
    const tt = event.ticketTypes[0];
    await createTestDiscountCode(event.id, tt.id, { code: "DUPE" });

    const result = await handleEditEvent(organizer.id, organizationId, {
      eventId: event.id,
      discountCodes: [{ clientId: "dc-dupe", code: "DUPE", type: "PERCENT_OFF", ticketTypeId: tt.id, percentOff: 5 }],
    });

    expect(result.ok).toBe(false);
    expect((result as any).reason).toBe("DISCOUNT_CODE_TAKEN");
  });

  it("rejects mismatched type/amount fields", async () => {
    const { user: organizer, organizationId } = await newOrganizer();
    const event = await createTestEvent(organizationId);
    const tt = event.ticketTypes[0];

    const result = await handleEditEvent(organizer.id, organizationId, {
      eventId: event.id,
      discountCodes: [{ clientId: "dc-bad", code: "BADCODE", type: "PERCENT_OFF", ticketTypeId: tt.id, amountOffCents: 500 }],
    });

    expect(result.ok).toBe(false);
    expect((result as any).reason).toBe("INVALID_DISCOUNT_CODE");
  });

  it("never deletes a discount code omitted from a later payload", async () => {
    const { user: organizer, organizationId } = await newOrganizer();
    const event = await createTestEvent(organizationId);
    const tt = event.ticketTypes[0];
    const code = await createTestDiscountCode(event.id, tt.id, { code: "KEEPME" });

    const result = await handleEditEvent(organizer.id, organizationId, {
      eventId: event.id,
      discountCodes: [],
    });

    expect(result.ok).toBe(true);
    const stillThere = await prisma.discountCode.findUnique({ where: { id: code.id } });
    expect(stillThere).not.toBeNull();
  });
});

describe("handleEditEvent", () => {
  it("creates a registration question with no id, then updates the same row on replay with the now-known id", async () => {
    const { user: organizer, organizationId } = await newOrganizer();
    const event = await createTestEvent(organizationId);

    const first = await handleEditEvent(organizer.id, organizationId, {
      eventId: event.id,
      registrationQuestions: [{ clientId: "q-client-1", label: "T-shirt size?", type: "SELECT", options: "S,M,L" }],
    });
    expect(first.ok).toBe(true);
    expect(first.event.registrationQuestions).toHaveLength(1);
    const created = first.event.registrationQuestions[0];
    expect(created.label).toBe("T-shirt size?");

    const second = await handleEditEvent(organizer.id, organizationId, {
      eventId: event.id,
      registrationQuestions: [{ id: created.id, clientId: "q-client-1", label: "T-shirt size (updated)?", type: "SELECT", options: "S,M,L,XL" }],
    });
    expect(second.ok).toBe(true);
    expect(second.event.registrationQuestions).toHaveLength(1);
    expect(second.event.registrationQuestions[0].id).toBe(created.id);
    expect(second.event.registrationQuestions[0].label).toBe("T-shirt size (updated)?");
  });

  it("never deletes a question omitted from a later payload", async () => {
    const { user: organizer, organizationId } = await newOrganizer();
    const event = await createTestEvent(organizationId);
    const question = await createTestRegistrationQuestion(event.id, { label: "Keep me" });

    const result = await handleEditEvent(organizer.id, organizationId, {
      eventId: event.id,
      registrationQuestions: [],
    });

    expect(result.ok).toBe(true);
    const stillThere = await prisma.registrationQuestion.findUnique({ where: { id: question.id } });
    expect(stillThere).not.toBeNull();
  });

  it("creates a survey question with no id, then updates the same row on replay with the now-known id (never appears in shapeEvent — organizer-only, verified via direct query)", async () => {
    const { user: organizer, organizationId } = await newOrganizer();
    const event = await createTestEvent(organizationId);

    const first = await handleEditEvent(organizer.id, organizationId, {
      eventId: event.id,
      surveyQuestions: [{ clientId: "sq-client-1", label: "How was it?", type: "TEXT" }],
    });
    expect(first.ok).toBe(true);
    expect((first.event as any).surveyQuestions).toBeUndefined();
    const stored = await prisma.surveyQuestion.findMany({ where: { eventId: event.id } });
    expect(stored).toHaveLength(1);
    expect(stored[0].label).toBe("How was it?");

    const second = await handleEditEvent(organizer.id, organizationId, {
      eventId: event.id,
      surveyQuestions: [{ id: stored[0].id, clientId: "sq-client-1", label: "How was the event overall?", type: "TEXT" }],
    });
    expect(second.ok).toBe(true);
    const restored = await prisma.surveyQuestion.findMany({ where: { eventId: event.id } });
    expect(restored).toHaveLength(1);
    expect(restored[0].id).toBe(stored[0].id);
    expect(restored[0].label).toBe("How was the event overall?");
  });

  it("never deletes a survey question omitted from a later payload", async () => {
    const { user: organizer, organizationId } = await newOrganizer();
    const event = await createTestEvent(organizationId);
    const question = await prisma.surveyQuestion.create({ data: { eventId: event.id, label: "Keep me", type: "TEXT" } });

    const result = await handleEditEvent(organizer.id, organizationId, {
      eventId: event.id,
      surveyQuestions: [],
    });

    expect(result.ok).toBe(true);
    const stillThere = await prisma.surveyQuestion.findUnique({ where: { id: question.id } });
    expect(stillThere).not.toBeNull();
  });

  it("sets and clears waiverText", async () => {
    const { user: organizer, organizationId } = await newOrganizer();
    const event = await createTestEvent(organizationId);

    const withWaiver = await handleEditEvent(organizer.id, organizationId, {
      eventId: event.id,
      waiverText: "Please sign here.",
    });
    expect(withWaiver.event.waiverText).toBe("Please sign here.");

    const cleared = await handleEditEvent(organizer.id, organizationId, {
      eventId: event.id,
      waiverText: null,
    });
    expect(cleared.event.waiverText).toBeNull();
  });
});

describe("handleCheckIn", () => {
  async function soldTicket() {
    const { user: organizer, organizationId } = await newOrganizer();
    const buyer = await createTestUser();
    const event = await createTestEvent(organizationId);
    const tt = event.ticketTypes[0];
    const sale = await handleSellTickets(buyer.id, {
      clientId: `checkin-${Date.now()}-${Math.random()}`,
      eventId: event.id,
      items: [{ ticketTypeId: tt.id, quantity: 1, codes: [`CHK-${Date.now()}-${Math.random()}`] }],
    });
    return { code: sale.order.tickets[0].code as string, organizer, organizationId };
  }

  it("checks a valid ticket in", async () => {
    const { code, organizer, organizationId } = await soldTicket();
    const result = await handleCheckIn(organizer.id, organizationId, { ticketCode: code });
    expect(result.ok).toBe(true);
    expect(result.ticket.checkedIn).toBe(true);
  });

  it("reports already-checked-in without erroring on replay", async () => {
    const { code, organizer, organizationId } = await soldTicket();
    await handleCheckIn(organizer.id, organizationId, { ticketCode: code });
    const second = await handleCheckIn(organizer.id, organizationId, { ticketCode: code });
    expect(second.ok).toBe(true);
    expect(second.alreadyCheckedIn).toBe(true);
  });

  it("returns retry:true for an unknown code", async () => {
    const { user: organizer, organizationId } = await newOrganizer();
    const result = await handleCheckIn(organizer.id, organizationId, { ticketCode: "NOPE-00000" });
    expect(result.ok).toBe(false);
    expect(result.retry).toBe(true);
    expect(result.reason).toBe("TICKET_NOT_FOUND");
  });

  it("rejects check-in for a ticket belonging to a different organization", async () => {
    const { code } = await soldTicket();
    const { user: someoneElse, organizationId: someoneElseOrgId } = await newOrganizer();
    const result = await handleCheckIn(someoneElse.id, someoneElseOrgId, { ticketCode: code });
    expect(result.ok).toBe(false);
    expect((result as any).reason).toBe("FORBIDDEN");
  });
});

describe("handleRefundOrder", () => {
  async function paidOrder() {
    const { user: organizer, organizationId } = await newOrganizer();
    const buyer = await createTestUser();
    const event = await createTestEvent(organizationId, [{ priceCents: 150000, quantityTotal: 10 }]);
    const tt = event.ticketTypes[0];
    const sale = await handleSellTickets(buyer.id, {
      clientId: `refund-${Date.now()}-${Math.random()}`,
      eventId: event.id,
      items: [{ ticketTypeId: tt.id, quantity: 1, codes: [`RFD-${Date.now()}-${Math.random()}`] }],
    });
    return { organizer, organizationId, buyer, event, tt, orderId: sale.order.id as string };
  }

  it("marks the order REFUNDED and gives the ticket type its inventory back", async () => {
    const { organizer, organizationId, tt, orderId } = await paidOrder();

    const result = await handleRefundOrder(organizer.id, organizationId, { orderId });

    expect(result.ok).toBe(true);
    expect(result.order.status).toBe("REFUNDED");
    const updatedTt = await prisma.ticketType.findUniqueOrThrow({ where: { id: tt.id } });
    expect(updatedTt.quantitySold).toBe(0);
  });

  it("same-org staff can refund an order, not just the org's owner", async () => {
    const { organizationId, orderId, tt } = await paidOrder();
    const staff = await createTestUser();
    await addMembership(organizationId, staff.id, "STAFF");

    const result = await handleRefundOrder(staff.id, organizationId, { orderId });

    expect(result.ok).toBe(true);
    expect(result.order.status).toBe("REFUNDED");
    const updatedTt = await prisma.ticketType.findUniqueOrThrow({ where: { id: tt.id } });
    expect(updatedTt.quantitySold).toBe(0);
  });

  it("refuses to refund an order from a different organization", async () => {
    const { orderId } = await paidOrder();
    const { user: someoneElse, organizationId: someoneElseOrgId } = await newOrganizer();

    const result = await handleRefundOrder(someoneElse.id, someoneElseOrgId, { orderId });

    expect(result.ok).toBe(false);
    expect(result.reason).toBe("FORBIDDEN");
  });

  it("blocks refunding an order that's already been settled", async () => {
    const { organizer, organizationId, orderId } = await paidOrder();

    const account = await prisma.mobileMoneyAccount.create({
      data: { provider: "MPESA_TZ", phoneNumber: "255700000000", accountName: "Test", organizationId },
    });
    const settlement = await prisma.settlement.create({
      data: {
        organizationId,
        mobileMoneyAccountId: account.id,
        periodStart: new Date(),
        periodEnd: new Date(),
        grossCents: 150000,
        platformFeeCents: 12000,
        netCents: 138000,
      },
    });
    await prisma.settlementItem.create({
      data: { settlementId: settlement.id, orderId, amountCents: 150000 },
    });

    const result = await handleRefundOrder(organizer.id, organizationId, { orderId });

    expect(result.ok).toBe(false);
    expect(result.reason).toBe("ALREADY_SETTLED");
    const order = await prisma.order.findUniqueOrThrow({ where: { id: orderId } });
    expect(order.status).toBe("PAID"); // unchanged
  });

  it("is idempotent — refunding an already-refunded order just returns it", async () => {
    const { organizer, organizationId, orderId } = await paidOrder();
    await handleRefundOrder(organizer.id, organizationId, { orderId });
    const second = await handleRefundOrder(organizer.id, organizationId, { orderId });
    expect(second.ok).toBe(true);
    expect(second.order.status).toBe("REFUNDED");
  });
});

describe("handleApplyVendor", () => {
  it("creates a PENDING vendor application", async () => {
    const { organizationId } = await newOrganizer();
    const applicant = await createTestUser();
    const event = await createTestEvent(organizationId, undefined, "TZS", { vendorApplicationsOpen: true });

    const result = await handleApplyVendor(applicant.id, {
      clientId: "vendor-client-1",
      eventId: event.id,
      name: "Mama Nia's Kitchen",
      category: "Food",
      contactEmail: "mamania@test.local",
      contactPhone: "0712345678",
    });

    expect(result.ok).toBe(true);
    expect(result.vendor.status).toBe("PENDING");
    expect(result.vendor.ownerUserId).toBe(applicant.id);
  });

  it("derives feeStatus from the event's stall fee, ignoring any client-sent value", async () => {
    const { organizationId } = await newOrganizer();
    const applicant = await createTestUser();
    const event = await createTestEvent(organizationId, undefined, "TZS", {
      vendorApplicationsOpen: true,
      vendorStallFeeCents: 5000,
    });

    const result = await handleApplyVendor(applicant.id, {
      clientId: "vendor-client-fee",
      eventId: event.id,
      name: "Kilimanjaro Crafts",
      category: "Merchandise",
      contactEmail: "crafts@test.local",
      contactPhone: "0712345679",
      // A malicious/buggy client sending its own fee status must not win.
      feeStatus: "NONE",
      stallFeeCents: 0,
    } as any);

    expect(result.ok).toBe(true);
    expect(result.vendor.feeStatus).toBe("PAID");
    expect(result.vendor.stallFeeCents).toBe(5000);
  });

  it("returns APPLICATIONS_CLOSED when the event isn't accepting vendors", async () => {
    const { organizationId } = await newOrganizer();
    const applicant = await createTestUser();
    const event = await createTestEvent(organizationId); // vendorApplicationsOpen defaults false

    const result = await handleApplyVendor(applicant.id, {
      clientId: "vendor-client-closed",
      eventId: event.id,
      name: "Late Applicant",
      category: "Other",
      contactEmail: "late@test.local",
      contactPhone: "0712345680",
    });

    expect(result.ok).toBe(false);
    expect((result as any).reason).toBe("APPLICATIONS_CLOSED");
  });

  it("is idempotent — replaying the same clientId doesn't create a duplicate vendor", async () => {
    const { organizationId } = await newOrganizer();
    const applicant = await createTestUser();
    const event = await createTestEvent(organizationId, undefined, "TZS", { vendorApplicationsOpen: true });
    const payload = {
      clientId: "vendor-client-replay",
      eventId: event.id,
      name: "Replay Vendor",
      category: "Food",
      contactEmail: "replay@test.local",
      contactPhone: "0712345681",
    };

    const first = await handleApplyVendor(applicant.id, payload);
    const second = await handleApplyVendor(applicant.id, payload);
    expect(first.vendor.id).toBe(second.vendor.id);
    expect(await prisma.vendor.count({ where: { clientId: "vendor-client-replay" } })).toBe(1);
  });

  it("returns retry:true when the event hasn't synced yet", async () => {
    const applicant = await createTestUser();
    const result = await handleApplyVendor(applicant.id, {
      clientId: "vendor-client-unsynced",
      eventId: "local:not-a-real-event",
      name: "Too Early",
      category: "Food",
      contactEmail: "early@test.local",
      contactPhone: "0712345682",
    });
    expect(result.ok).toBe(false);
    expect((result as any).retry).toBe(true);
  });
});

describe("handleAddVendor", () => {
  it("creates an APPROVED vendor directly with the given badge code", async () => {
    const { user: organizer, organizationId } = await newOrganizer();
    const event = await createTestEvent(organizationId);

    const result = await handleAddVendor(organizer.id, organizationId, {
      clientId: "vendor-manual-1",
      eventId: event.id,
      name: "Walk-up Grill",
      category: "Food",
      badgeCode: "VENDR-00001",
    });

    expect(result.ok).toBe(true);
    expect(result.vendor.status).toBe("APPROVED");
    expect(result.vendor.badgeCode).toBe("VENDR-00001");
  });

  it("same-org staff can add a vendor, not just the org's owner", async () => {
    const { organizationId } = await newOrganizer();
    const staff = await createTestUser();
    await addMembership(organizationId, staff.id, "STAFF");
    const event = await createTestEvent(organizationId);

    const result = await handleAddVendor(staff.id, organizationId, {
      clientId: "vendor-manual-staff",
      eventId: event.id,
      name: "Staff-added Stall",
      category: "Food",
      badgeCode: "VENDR-STAFF-1",
    });

    expect(result.ok).toBe(true);
    expect(result.vendor.status).toBe("APPROVED");
  });

  it("refuses to add a vendor to an event owned by a different organization", async () => {
    const { organizationId } = await newOrganizer();
    const { user: someoneElse, organizationId: someoneElseOrgId } = await newOrganizer();
    const event = await createTestEvent(organizationId);

    const result = await handleAddVendor(someoneElse.id, someoneElseOrgId, {
      clientId: "vendor-manual-forbidden",
      eventId: event.id,
      name: "Interloper",
      category: "Other",
      badgeCode: "VENDR-00002",
    });

    expect(result.ok).toBe(false);
    expect((result as any).reason).toBe("FORBIDDEN");
  });

  it("is idempotent — replaying the same clientId doesn't create a duplicate", async () => {
    const { user: organizer, organizationId } = await newOrganizer();
    const event = await createTestEvent(organizationId);
    const payload = {
      clientId: "vendor-manual-replay",
      eventId: event.id,
      name: "Replay Stall",
      category: "Food",
      badgeCode: "VENDR-00003",
    };

    await handleAddVendor(organizer.id, organizationId, payload);
    await handleAddVendor(organizer.id, organizationId, payload);
    expect(await prisma.vendor.count({ where: { clientId: "vendor-manual-replay" } })).toBe(1);
  });
});

describe("handleAddSponsor", () => {
  it("creates a sponsor directly with the given tier", async () => {
    const { user: organizer, organizationId } = await newOrganizer();
    const event = await createTestEvent(organizationId);

    const result = await handleAddSponsor(organizer.id, organizationId, {
      clientId: "sponsor-1",
      eventId: event.id,
      name: "Red Bull",
      tier: "Gold",
      feeCents: 500000,
    });

    expect(result.ok).toBe(true);
    expect(result.sponsor.name).toBe("Red Bull");
    expect(result.sponsor.tier).toBe("Gold");
    expect(result.sponsor.feeCents).toBe(500000);
  });

  it("refuses to add a sponsor to an event owned by a different organization", async () => {
    const { organizationId } = await newOrganizer();
    const { user: someoneElse, organizationId: someoneElseOrgId } = await newOrganizer();
    const event = await createTestEvent(organizationId);

    const result = await handleAddSponsor(someoneElse.id, someoneElseOrgId, {
      clientId: "sponsor-forbidden",
      eventId: event.id,
      name: "Interloper",
      tier: "Bronze",
    });

    expect(result.ok).toBe(false);
    expect((result as any).reason).toBe("FORBIDDEN");
  });

  it("is idempotent — replaying the same clientId doesn't create a duplicate", async () => {
    const { user: organizer, organizationId } = await newOrganizer();
    const event = await createTestEvent(organizationId);
    const payload = {
      clientId: "sponsor-replay",
      eventId: event.id,
      name: "Replay Sponsor",
      tier: "Silver",
    };

    await handleAddSponsor(organizer.id, organizationId, payload);
    await handleAddSponsor(organizer.id, organizationId, payload);
    expect(await prisma.sponsor.count({ where: { clientId: "sponsor-replay" } })).toBe(1);
  });
});

describe("handleSponsorTap", () => {
  async function sponsorAndWallet() {
    const { user: organizer, organizationId } = await newOrganizer();
    const attendee = await createTestUser();
    const event = await createTestEvent(organizationId);
    const sponsor = await createTestSponsor(event.id, { name: "Acme Corp" });
    const wallet = await createTestWallet(event.id, attendee.id);
    return { organizer, organizationId, attendee, event, sponsor, wallet };
  }

  it("persists a non-empty note", async () => {
    const { organizer, organizationId, sponsor, wallet } = await sponsorAndWallet();

    const result = await handleSponsorTap(organizer.id, organizationId, {
      clientId: "tap-with-note",
      walletCode: wallet.code,
      sponsorId: sponsor.id,
      eventId: wallet.eventId,
      note: "  interested in the Series A demo  ",
    });

    expect(result.ok).toBe(true);
    expect((result as any).transaction.note).toBe("interested in the Series A demo");
    const stored = await prisma.walletTransaction.findUniqueOrThrow({ where: { clientId: "tap-with-note" } });
    expect(stored.note).toBe("interested in the Series A demo");
  });

  it("collapses an omitted, blank, or whitespace-only note to null", async () => {
    const { organizer, organizationId, sponsor, wallet } = await sponsorAndWallet();

    const omitted = await handleSponsorTap(organizer.id, organizationId, {
      clientId: "tap-omitted",
      walletCode: wallet.code,
      sponsorId: sponsor.id,
      eventId: wallet.eventId,
    });
    expect((omitted as any).transaction.note).toBeNull();

    const blank = await handleSponsorTap(organizer.id, organizationId, {
      clientId: "tap-blank",
      walletCode: wallet.code,
      sponsorId: sponsor.id,
      eventId: wallet.eventId,
      note: "   ",
    });
    expect((blank as any).transaction.note).toBeNull();
    const stored = await prisma.walletTransaction.findUniqueOrThrow({ where: { clientId: "tap-blank" } });
    expect(stored.note).toBeNull(); // never an empty string
  });

  it("is idempotent — replaying the same clientId doesn't duplicate the row or drop the note", async () => {
    const { organizer, organizationId, sponsor, wallet } = await sponsorAndWallet();
    // Unique per run, not a bare literal — this exact literal ("tap-replay")
    // used to collide with an identically-named clientId in a completely
    // different file (wallet-handlers.test.ts), which also has its own
    // handleSponsorTap idempotent-replay test. Since WalletTransaction.clientId
    // is globally unique and the two tests run in the same shared DB within
    // one `npm test` invocation, whichever file's test ran second would find
    // the first file's row (a different organization) and hit the
    // cross-org-mismatch FORBIDDEN branch instead of actually exercising
    // idempotent replay — surfacing here as `second.transaction` being
    // undefined. Neither test's assertion was a raw-count check sensitive
    // enough to catch it except this one's `.transaction.note` check. Fixed
    // by making the clientId collision-proof instead of chasing file load
    // order.
    const clientId = `tap-replay-${Date.now()}-${Math.random()}`;
    const payload = {
      clientId,
      walletCode: wallet.code,
      sponsorId: sponsor.id,
      eventId: wallet.eventId,
      note: "call back next week",
    };

    await handleSponsorTap(organizer.id, organizationId, payload);
    const second = await handleSponsorTap(organizer.id, organizationId, payload);

    expect(await prisma.walletTransaction.count({ where: { clientId } })).toBe(1);
    expect((second as any).transaction.note).toBe("call back next week");
  });

  it("payloadSchemas.SPONSOR_TAP rejects a note over 500 chars", () => {
    const parsed = payloadSchemas.SPONSOR_TAP.safeParse({
      clientId: "x",
      walletCode: "CODE",
      sponsorId: "sponsor-1",
      eventId: "event-1",
      note: "a".repeat(501),
    });
    expect(parsed.success).toBe(false);
  });

  it("payloadSchemas.SPONSOR_TAP accepts a payload with no note key at all", () => {
    // Back-compat: an already-offline-queued tap from before this field
    // existed has no `note` key at all and must still parse.
    const parsed = payloadSchemas.SPONSOR_TAP.safeParse({
      clientId: "x",
      walletCode: "CODE",
      sponsorId: "sponsor-1",
      eventId: "event-1",
    });
    expect(parsed.success).toBe(true);
  });

  it("redemption succeeds and increments the campaign's redemptionCount", async () => {
    const { organizer, organizationId, sponsor, wallet } = await sponsorAndWallet();
    const campaign = await createTestSponsorCampaign(sponsor.id, { name: "Free Sample" });

    const result = await handleSponsorTap(organizer.id, organizationId, {
      clientId: "tap-redeem",
      walletCode: wallet.code,
      sponsorId: sponsor.id,
      eventId: wallet.eventId,
      campaignId: campaign.id,
    });

    expect(result.ok).toBe(true);
    expect((result as any).campaignRedeemed).toBe(true);
    expect((result as any).campaignRejectReason).toBeNull();
    expect((result as any).transaction.campaignId).toBe(campaign.id);
    const stored = await prisma.sponsorCampaign.findUniqueOrThrow({ where: { id: campaign.id } });
    expect(stored.redemptionCount).toBe(1);
  });

  it("soft-fails for an unknown, inactive, or expired campaign — tap still recorded", async () => {
    const { organizer, organizationId, sponsor, wallet } = await sponsorAndWallet();
    const inactive = await createTestSponsorCampaign(sponsor.id, { active: false });
    const expired = await createTestSponsorCampaign(sponsor.id, { expiresAt: new Date(Date.now() - 1000) });

    const unknown = await handleSponsorTap(organizer.id, organizationId, {
      clientId: "tap-unknown-campaign",
      walletCode: wallet.code,
      sponsorId: sponsor.id,
      eventId: wallet.eventId,
      campaignId: "does-not-exist",
    });
    expect(unknown.ok).toBe(true);
    expect((unknown as any).campaignRedeemed).toBe(false);
    expect((unknown as any).campaignRejectReason).toBe("CAMPAIGN_NOT_FOUND");

    const inactiveResult = await handleSponsorTap(organizer.id, organizationId, {
      clientId: "tap-inactive-campaign",
      walletCode: wallet.code,
      sponsorId: sponsor.id,
      eventId: wallet.eventId,
      campaignId: inactive.id,
    });
    expect((inactiveResult as any).campaignRejectReason).toBe("CAMPAIGN_INACTIVE");

    const expiredResult = await handleSponsorTap(organizer.id, organizationId, {
      clientId: "tap-expired-campaign",
      walletCode: wallet.code,
      sponsorId: sponsor.id,
      eventId: wallet.eventId,
      campaignId: expired.id,
    });
    expect((expiredResult as any).campaignRejectReason).toBe("CAMPAIGN_EXPIRED");

    // All three still recorded a tap despite the campaign soft-failing.
    expect(await prisma.walletTransaction.count({ where: { clientId: { in: ["tap-unknown-campaign", "tap-inactive-campaign", "tap-expired-campaign"] } } })).toBe(3);
  });

  it("soft-fails once a campaign's max redemptions is reached", async () => {
    const { organizer, organizationId, sponsor, wallet } = await sponsorAndWallet();
    const campaign = await createTestSponsorCampaign(sponsor.id, { maxRedemptions: 1 });

    await handleSponsorTap(organizer.id, organizationId, {
      clientId: "tap-maxed-1",
      walletCode: wallet.code,
      sponsorId: sponsor.id,
      eventId: wallet.eventId,
      campaignId: campaign.id,
    });

    const otherAttendee = await createTestUser();
    const otherWallet = await createTestWallet(wallet.eventId, otherAttendee.id);
    const second = await handleSponsorTap(organizer.id, organizationId, {
      clientId: "tap-maxed-2",
      walletCode: otherWallet.code,
      sponsorId: sponsor.id,
      eventId: wallet.eventId,
      campaignId: campaign.id,
    });

    expect((second as any).campaignRedeemed).toBe(false);
    expect((second as any).campaignRejectReason).toBe("CAMPAIGN_MAX_REDEEMED");
  });

  it("soft-fails when the same wallet redeems the same campaign twice", async () => {
    const { organizer, organizationId, sponsor, wallet } = await sponsorAndWallet();
    const campaign = await createTestSponsorCampaign(sponsor.id);

    await handleSponsorTap(organizer.id, organizationId, {
      clientId: "tap-first-redemption",
      walletCode: wallet.code,
      sponsorId: sponsor.id,
      eventId: wallet.eventId,
      campaignId: campaign.id,
    });

    const second = await handleSponsorTap(organizer.id, organizationId, {
      clientId: "tap-second-redemption",
      walletCode: wallet.code,
      sponsorId: sponsor.id,
      eventId: wallet.eventId,
      campaignId: campaign.id,
    });

    expect(second.ok).toBe(true); // tap still recorded
    expect((second as any).campaignRedeemed).toBe(false);
    expect((second as any).campaignRejectReason).toBe("CAMPAIGN_ALREADY_REDEEMED");
    expect(await prisma.walletTransaction.count({ where: { clientId: "tap-second-redemption" } })).toBe(1);
    const stored = await prisma.sponsorCampaign.findUniqueOrThrow({ where: { id: campaign.id } });
    expect(stored.redemptionCount).toBe(1); // not incremented twice
  });

  it("a concurrency race on the last redemption slot lets exactly one attendee win", async () => {
    const { organizer, organizationId, sponsor, wallet } = await sponsorAndWallet();
    const campaign = await createTestSponsorCampaign(sponsor.id, { maxRedemptions: 1 });
    const otherAttendee = await createTestUser();
    const otherWallet = await createTestWallet(wallet.eventId, otherAttendee.id);

    const [a, b] = await Promise.all([
      handleSponsorTap(organizer.id, organizationId, {
        clientId: "tap-race-a",
        walletCode: wallet.code,
        sponsorId: sponsor.id,
        eventId: wallet.eventId,
        campaignId: campaign.id,
      }),
      handleSponsorTap(organizer.id, organizationId, {
        clientId: "tap-race-b",
        walletCode: otherWallet.code,
        sponsorId: sponsor.id,
        eventId: wallet.eventId,
        campaignId: campaign.id,
      }),
    ]);

    const outcomes = [a, b].map((r) => (r as any).campaignRedeemed);
    expect(outcomes.filter(Boolean)).toHaveLength(1);
    const stored = await prisma.sponsorCampaign.findUniqueOrThrow({ where: { id: campaign.id } });
    expect(stored.redemptionCount).toBe(1);
  });
});

describe("handleAddSponsorCampaign", () => {
  it("creates a campaign directly with an uppercased, trimmed code", async () => {
    const { user: organizer, organizationId } = await newOrganizer();
    const event = await createTestEvent(organizationId);
    const sponsor = await createTestSponsor(event.id);

    const result = await handleAddSponsorCampaign(organizer.id, organizationId, {
      clientId: "campaign-1",
      sponsorId: sponsor.id,
      name: "Free Sample",
      code: " free ",
      maxRedemptions: 100,
    });

    expect(result.ok).toBe(true);
    expect((result as any).campaign.code).toBe("FREE");
    expect((result as any).campaign.name).toBe("Free Sample");
  });

  it("refuses to add a campaign to a sponsor owned by a different organization", async () => {
    const { organizationId } = await newOrganizer();
    const event = await createTestEvent(organizationId);
    const sponsor = await createTestSponsor(event.id);
    const { user: someoneElse, organizationId: someoneElseOrgId } = await newOrganizer();

    const result = await handleAddSponsorCampaign(someoneElse.id, someoneElseOrgId, {
      clientId: "campaign-forbidden",
      sponsorId: sponsor.id,
      name: "Interloper",
      code: "NOPE",
    });

    expect(result.ok).toBe(false);
    expect((result as any).reason).toBe("FORBIDDEN");
  });

  it("is idempotent — replaying the same clientId doesn't create a duplicate", async () => {
    const { user: organizer, organizationId } = await newOrganizer();
    const event = await createTestEvent(organizationId);
    const sponsor = await createTestSponsor(event.id);
    const payload = { clientId: "campaign-replay", sponsorId: sponsor.id, name: "Replay Campaign", code: "REPLAY" };

    await handleAddSponsorCampaign(organizer.id, organizationId, payload);
    await handleAddSponsorCampaign(organizer.id, organizationId, payload);
    expect(await prisma.sponsorCampaign.count({ where: { clientId: "campaign-replay" } })).toBe(1);
  });

  it("rejects a duplicate (sponsorId, code) pair", async () => {
    const { user: organizer, organizationId } = await newOrganizer();
    const event = await createTestEvent(organizationId);
    const sponsor = await createTestSponsor(event.id);
    await createTestSponsorCampaign(sponsor.id, { code: "DUPE" });

    const result = await handleAddSponsorCampaign(organizer.id, organizationId, {
      clientId: "campaign-dupe",
      sponsorId: sponsor.id,
      name: "Another",
      code: "DUPE",
    });

    expect(result.ok).toBe(false);
    expect((result as any).reason).toBe("CAMPAIGN_CODE_TAKEN");
  });
});

describe("handleDeactivateSponsorCampaign", () => {
  it("sets active to false", async () => {
    const { user: organizer, organizationId } = await newOrganizer();
    const event = await createTestEvent(organizationId);
    const sponsor = await createTestSponsor(event.id);
    const campaign = await createTestSponsorCampaign(sponsor.id);

    const result = await handleDeactivateSponsorCampaign(organizer.id, organizationId, {
      clientId: "deactivate-1",
      campaignId: campaign.id,
    });

    expect(result.ok).toBe(true);
    expect((result as any).campaign.active).toBe(false);
  });

  it("is cross-org guarded", async () => {
    const { organizationId } = await newOrganizer();
    const event = await createTestEvent(organizationId);
    const sponsor = await createTestSponsor(event.id);
    const campaign = await createTestSponsorCampaign(sponsor.id);
    const { organizationId: otherOrgId } = await newOrganizer();

    const result = await handleDeactivateSponsorCampaign("irrelevant", otherOrgId, {
      clientId: "deactivate-forbidden",
      campaignId: campaign.id,
    });

    expect(result.ok).toBe(false);
    expect((result as any).reason).toBe("FORBIDDEN");
  });

  it("is idempotent on an already-inactive campaign", async () => {
    const { user: organizer, organizationId } = await newOrganizer();
    const event = await createTestEvent(organizationId);
    const sponsor = await createTestSponsor(event.id);
    const campaign = await createTestSponsorCampaign(sponsor.id, { active: false });

    const result = await handleDeactivateSponsorCampaign(organizer.id, organizationId, {
      clientId: "deactivate-idempotent",
      campaignId: campaign.id,
    });

    expect(result.ok).toBe(true);
    expect((result as any).campaign.active).toBe(false);
  });
});

describe("handleApproveVendor / handleRejectVendor", () => {
  async function pendingVendor(vendorStallFeeCents = 0) {
    const { user: organizer, organizationId } = await newOrganizer();
    const applicant = await createTestUser();
    const event = await createTestEvent(organizationId, undefined, "TZS", {
      vendorApplicationsOpen: true,
      vendorStallFeeCents,
    });
    const applied = await handleApplyVendor(applicant.id, {
      clientId: `vendor-pending-${event.id}`,
      eventId: event.id,
      name: "Pending Vendor",
      category: "Food",
      contactEmail: "pending@test.local",
      contactPhone: "0712345683",
    });
    return { organizer, organizationId, applicant, event, vendorId: applied.vendor.id };
  }

  it("approves a pending vendor and assigns booth + badge", async () => {
    const { organizer, organizationId, vendorId } = await pendingVendor();
    const result = await handleApproveVendor(organizer.id, organizationId, {
      vendorId,
      boothNumber: "A12",
      badgeCode: "VENDR-APPROVE-1",
    });
    expect(result.ok).toBe(true);
    expect(result.vendor.status).toBe("APPROVED");
    expect(result.vendor.boothNumber).toBe("A12");
    expect(result.vendor.badgeCode).toBe("VENDR-APPROVE-1");
  });

  it("refuses to approve a vendor on an event owned by a different organization", async () => {
    const { vendorId } = await pendingVendor();
    const { user: someoneElse, organizationId: someoneElseOrgId } = await newOrganizer();
    const result = await handleApproveVendor(someoneElse.id, someoneElseOrgId, { vendorId, badgeCode: "VENDR-X" });
    expect(result.ok).toBe(false);
    expect((result as any).reason).toBe("FORBIDDEN");
  });

  it("is idempotent — approving an already-approved vendor just returns it", async () => {
    const { organizer, organizationId, vendorId } = await pendingVendor();
    await handleApproveVendor(organizer.id, organizationId, { vendorId, badgeCode: "VENDR-IDEM-1" });
    const second = await handleApproveVendor(organizer.id, organizationId, { vendorId, badgeCode: "VENDR-IDEM-2" });
    expect(second.ok).toBe(true);
    expect(second.vendor.status).toBe("APPROVED");
    // second call's badge code is ignored — already-approved vendors keep theirs
    expect(second.vendor.badgeCode).toBe("VENDR-IDEM-1");
  });

  it("rejects a pending vendor", async () => {
    const { organizer, organizationId, vendorId } = await pendingVendor();
    const result = await handleRejectVendor(organizer.id, organizationId, { vendorId });
    expect(result.ok).toBe(true);
    expect(result.vendor.status).toBe("REJECTED");
  });

  it("refunds a paid fee symbolically on rejection — feeStatus becomes REFUNDED", async () => {
    const { organizer, organizationId, vendorId } = await pendingVendor(5000);
    const result = await handleRejectVendor(organizer.id, organizationId, { vendorId });
    expect(result.ok).toBe(true);
    expect(result.vendor.feeStatus).toBe("REFUNDED");
  });

  it("refuses to reject a vendor on an event owned by a different organization", async () => {
    const { vendorId } = await pendingVendor();
    const { user: someoneElse, organizationId: someoneElseOrgId } = await newOrganizer();
    const result = await handleRejectVendor(someoneElse.id, someoneElseOrgId, { vendorId });
    expect(result.ok).toBe(false);
    expect((result as any).reason).toBe("FORBIDDEN");
  });
});

describe("handleCheckInVendor", () => {
  async function approvedVendor() {
    const { user: organizer, organizationId } = await newOrganizer();
    const event = await createTestEvent(organizationId);
    const added = await handleAddVendor(organizer.id, organizationId, {
      clientId: `vendor-checkin-${event.id}`,
      eventId: event.id,
      name: "Gate Test Vendor",
      category: "Food",
      badgeCode: `VENDR-CHECKIN-${event.id}`,
    });
    return { organizer, organizationId, event, badgeCode: added.vendor.badgeCode as string };
  }

  it("checks an approved vendor's badge in", async () => {
    const { badgeCode, organizer, organizationId } = await approvedVendor();
    const result = await handleCheckInVendor(organizer.id, organizationId, { badgeCode });
    expect(result.ok).toBe(true);
    expect(result.vendor.checkedIn).toBe(true);
  });

  it("reports already-checked-in without erroring on replay", async () => {
    const { badgeCode, organizer, organizationId } = await approvedVendor();
    await handleCheckInVendor(organizer.id, organizationId, { badgeCode });
    const second = await handleCheckInVendor(organizer.id, organizationId, { badgeCode });
    expect(second.ok).toBe(true);
    expect((second as any).alreadyCheckedIn).toBe(true);
  });

  it("returns NOT_APPROVED for a badge whose vendor was rejected after approval", async () => {
    // A badge only exists once a vendor is approved — the realistic path to
    // NOT_APPROVED is an organizer reverting that decision afterward, not a
    // badge that was never issued (that's VENDOR_NOT_FOUND instead).
    const { organizer, organizationId, vendorId } = await (async () => {
      const { user: organizer, organizationId } = await newOrganizer();
      const event = await createTestEvent(organizationId);
      const added = await handleAddVendor(organizer.id, organizationId, {
        clientId: `vendor-torevoke-${event.id}`,
        eventId: event.id,
        name: "Revoked Vendor",
        category: "Food",
        badgeCode: `VENDR-REVOKE-${event.id}`,
      });
      return { organizer, organizationId, vendorId: added.vendor.id, badgeCode: added.vendor.badgeCode };
    })();
    const rejected = await handleRejectVendor(organizer.id, organizationId, { vendorId });

    const result = await handleCheckInVendor(organizer.id, organizationId, { badgeCode: rejected.vendor.badgeCode });
    expect(result.ok).toBe(false);
    expect((result as any).reason).toBe("NOT_APPROVED");
  });

  it("returns retry:true for an unknown badge code", async () => {
    const { user: organizer, organizationId } = await newOrganizer();
    const result = await handleCheckInVendor(organizer.id, organizationId, { badgeCode: "VENDR-UNKNOWN" });
    expect(result.ok).toBe(false);
    expect((result as any).retry).toBe(true);
  });

  it("rejects badge check-in for a vendor belonging to a different organization", async () => {
    const { badgeCode } = await approvedVendor();
    const { user: someoneElse, organizationId: someoneElseOrgId } = await newOrganizer();
    const result = await handleCheckInVendor(someoneElse.id, someoneElseOrgId, { badgeCode });
    expect(result.ok).toBe(false);
    expect((result as any).reason).toBe("FORBIDDEN");
  });
});
