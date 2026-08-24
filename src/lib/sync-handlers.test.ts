import { describe, expect, it } from "vitest";
import { prisma } from "@/lib/prisma";
import { createTestEvent, createTestUser } from "@/lib/test-fixtures";
import { handleSellTickets, handleCheckIn, handleRefundOrder } from "@/lib/sync-handlers";

describe("handleSellTickets", () => {
  it("creates a PAID order and increments quantitySold", async () => {
    const organizer = await createTestUser();
    const buyer = await createTestUser();
    const event = await createTestEvent(organizer.id, [{ priceCents: 200000, quantityTotal: 10 }]);
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
    const organizer = await createTestUser();
    const buyer = await createTestUser();
    const event = await createTestEvent(organizer.id);
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
    const organizer = await createTestUser();
    const buyer = await createTestUser();
    const event = await createTestEvent(organizer.id, [{ priceCents: 100000, quantityTotal: 1, quantitySold: 1 }]);
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
    const organizer = await createTestUser();
    const buyer = await createTestUser();
    const event = await createTestEvent(organizer.id, [{ priceCents: 100000, quantityTotal: 10 }]);
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
});

describe("handleCheckIn", () => {
  async function soldTicket() {
    const organizer = await createTestUser();
    const buyer = await createTestUser();
    const event = await createTestEvent(organizer.id);
    const tt = event.ticketTypes[0];
    const sale = await handleSellTickets(buyer.id, {
      clientId: `checkin-${Date.now()}-${Math.random()}`,
      eventId: event.id,
      items: [{ ticketTypeId: tt.id, quantity: 1, codes: [`CHK-${Date.now()}-${Math.random()}`] }],
    });
    return sale.order.tickets[0].code as string;
  }

  it("checks a valid ticket in", async () => {
    const code = await soldTicket();
    const result = await handleCheckIn({ ticketCode: code });
    expect(result.ok).toBe(true);
    expect(result.ticket.checkedIn).toBe(true);
  });

  it("reports already-checked-in without erroring on replay", async () => {
    const code = await soldTicket();
    await handleCheckIn({ ticketCode: code });
    const second = await handleCheckIn({ ticketCode: code });
    expect(second.ok).toBe(true);
    expect(second.alreadyCheckedIn).toBe(true);
  });

  it("returns retry:true for an unknown code", async () => {
    const result = await handleCheckIn({ ticketCode: "NOPE-00000" });
    expect(result.ok).toBe(false);
    expect(result.retry).toBe(true);
    expect(result.reason).toBe("TICKET_NOT_FOUND");
  });
});

describe("handleRefundOrder", () => {
  async function paidOrder() {
    const organizer = await createTestUser();
    const buyer = await createTestUser();
    const event = await createTestEvent(organizer.id, [{ priceCents: 150000, quantityTotal: 10 }]);
    const tt = event.ticketTypes[0];
    const sale = await handleSellTickets(buyer.id, {
      clientId: `refund-${Date.now()}-${Math.random()}`,
      eventId: event.id,
      items: [{ ticketTypeId: tt.id, quantity: 1, codes: [`RFD-${Date.now()}-${Math.random()}`] }],
    });
    return { organizer, buyer, event, tt, orderId: sale.order.id as string };
  }

  it("marks the order REFUNDED and gives the ticket type its inventory back", async () => {
    const { organizer, tt, orderId } = await paidOrder();

    const result = await handleRefundOrder(organizer.id, { orderId });

    expect(result.ok).toBe(true);
    expect(result.order.status).toBe("REFUNDED");
    const updatedTt = await prisma.ticketType.findUniqueOrThrow({ where: { id: tt.id } });
    expect(updatedTt.quantitySold).toBe(0);
  });

  it("refuses to refund an order that isn't yours", async () => {
    const { orderId } = await paidOrder();
    const someoneElse = await createTestUser();

    const result = await handleRefundOrder(someoneElse.id, { orderId });

    expect(result.ok).toBe(false);
    expect(result.reason).toBe("FORBIDDEN");
  });

  it("blocks refunding an order that's already been settled", async () => {
    const { organizer, orderId } = await paidOrder();

    const account = await prisma.mobileMoneyAccount.create({
      data: { provider: "MPESA_TZ", phoneNumber: "255700000000", accountName: "Test", organizerId: organizer.id },
    });
    const settlement = await prisma.settlement.create({
      data: {
        organizerId: organizer.id,
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

    const result = await handleRefundOrder(organizer.id, { orderId });

    expect(result.ok).toBe(false);
    expect(result.reason).toBe("ALREADY_SETTLED");
    const order = await prisma.order.findUniqueOrThrow({ where: { id: orderId } });
    expect(order.status).toBe("PAID"); // unchanged
  });

  it("is idempotent — refunding an already-refunded order just returns it", async () => {
    const { organizer, orderId } = await paidOrder();
    await handleRefundOrder(organizer.id, { orderId });
    const second = await handleRefundOrder(organizer.id, { orderId });
    expect(second.ok).toBe(true);
    expect(second.order.status).toBe("REFUNDED");
  });
});
