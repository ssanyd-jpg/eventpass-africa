import { describe, expect, it } from "vitest";
import { prisma } from "@/lib/prisma";
import { handlePaymentReversal } from "@/lib/payment-reversal";
import { handleCheckIn } from "@/lib/sync-handlers";
import { createTestUser, createTestOrganization, addMembership, createPaidOrder } from "@/lib/test-fixtures";

// createPaidOrder goes through the simulated payment provider (no
// paymentMethod/AIRPAY_ONLINE passed), which resolves PAID synchronously —
// no AirPay mocking needed, unlike sync-handlers.test.ts's own
// handleCheckOrderPaymentStatus/handleCheckIn describes.
//
// Phone numbers must be unique per call, not hardcoded literals shared
// across tests: NotificationLog has no orderId column (see reminders.ts's
// own comment on this), so a query scoped by `recipient` alone will match
// every row ever sent to that literal number across every test (and every
// retry) in this file, not just the current one.
let phoneCounter = 0;
function uniquePhone(): string {
  phoneCounter += 1;
  return `07${String(10_000_000 + phoneCounter).padStart(8, "0")}`;
}

async function paidOrderWithPhones() {
  const ownerRaw = await createTestUser();
  const owner = await prisma.user.update({ where: { id: ownerRaw.id }, data: { phone: uniquePhone() } });
  const organization = await createTestOrganization();
  await addMembership(organization.id, owner.id, "OWNER");
  const buyerRaw = await createTestUser();
  const buyer = await prisma.user.update({ where: { id: buyerRaw.id }, data: { phone: uniquePhone() } });
  const { event, order } = await createPaidOrder(organization.id, buyer.id, 100000);
  return { owner, buyer, event, order };
}

describe("handlePaymentReversal", () => {
  it("marks the order REVERSED and blocks check-in for every ticket on it", async () => {
    const { owner, order, event } = await paidOrderWithPhones();
    const ticket = await prisma.ticket.findFirstOrThrow({ where: { orderId: order.id } });

    const result = await handlePaymentReversal(order.id, "AP-REF-1");

    expect(result.ok).toBe(true);
    expect((result as { order: { status: string } }).order.status).toBe("REVERSED");
    const fresh = await prisma.order.findUniqueOrThrow({ where: { id: order.id } });
    expect(fresh.status).toBe("REVERSED");

    const checkIn = await handleCheckIn(owner.id, event.organizationId, { ticketCode: ticket.code });
    expect(checkIn).toEqual({ ok: false, reason: "ORDER_REVERSED" });
  });

  it("sends a WhatsApp notice to both the attendee and the org OWNER", async () => {
    const { owner, buyer, order } = await paidOrderWithPhones();

    await handlePaymentReversal(order.id, "AP-REF-2");

    const attendeeLog = await prisma.notificationLog.findFirst({
      where: { type: "PAYMENT_REVERSED", recipient: buyer.phone! },
    });
    expect(attendeeLog).not.toBeNull();
    expect(attendeeLog!.body).toContain("suspended");

    const organiserLog = await prisma.notificationLog.findFirst({
      where: { type: "PAYMENT_REVERSED", recipient: owner.phone! },
    });
    expect(organiserLog).not.toBeNull();
    expect(organiserLog!.body).toContain(order.id);
  });

  it("is idempotent — a second reversal on an already-REVERSED order is a no-op", async () => {
    const { buyer, order } = await paidOrderWithPhones();

    await handlePaymentReversal(order.id, "AP-REF-3");
    const result = await handlePaymentReversal(order.id, "AP-REF-3-retry");

    expect(result).toMatchObject({ ok: true, skipped: true, reason: "ALREADY_REVERSED" });
    expect(
      await prisma.notificationLog.count({ where: { type: "PAYMENT_REVERSED", recipient: buyer.phone! } })
    ).toBe(1);
  });

  it("returns ORDER_NOT_FOUND for an unknown order id", async () => {
    const result = await handlePaymentReversal("not-a-real-order-id", "AP-REF-4");
    expect(result).toEqual({ ok: false, reason: "ORDER_NOT_FOUND" });
  });
});
