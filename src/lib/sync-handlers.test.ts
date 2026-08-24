import { describe, expect, it } from "vitest";
import { prisma } from "@/lib/prisma";
import { createTestEvent, createTestUser } from "@/lib/test-fixtures";
import {
  handleSellTickets,
  handleCheckIn,
  handleRefundOrder,
  handleApplyVendor,
  handleAddVendor,
  handleApproveVendor,
  handleRejectVendor,
  handleCheckInVendor,
} from "@/lib/sync-handlers";

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

describe("handleApplyVendor", () => {
  it("creates a PENDING vendor application", async () => {
    const organizer = await createTestUser();
    const applicant = await createTestUser();
    const event = await createTestEvent(organizer.id, undefined, "TZS", { vendorApplicationsOpen: true });

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
    const organizer = await createTestUser();
    const applicant = await createTestUser();
    const event = await createTestEvent(organizer.id, undefined, "TZS", {
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
    const organizer = await createTestUser();
    const applicant = await createTestUser();
    const event = await createTestEvent(organizer.id); // vendorApplicationsOpen defaults false

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
    const organizer = await createTestUser();
    const applicant = await createTestUser();
    const event = await createTestEvent(organizer.id, undefined, "TZS", { vendorApplicationsOpen: true });
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
    const organizer = await createTestUser();
    const event = await createTestEvent(organizer.id);

    const result = await handleAddVendor(organizer.id, {
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

  it("refuses to add a vendor to an event you don't organize", async () => {
    const organizer = await createTestUser();
    const someoneElse = await createTestUser();
    const event = await createTestEvent(organizer.id);

    const result = await handleAddVendor(someoneElse.id, {
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
    const organizer = await createTestUser();
    const event = await createTestEvent(organizer.id);
    const payload = {
      clientId: "vendor-manual-replay",
      eventId: event.id,
      name: "Replay Stall",
      category: "Food",
      badgeCode: "VENDR-00003",
    };

    await handleAddVendor(organizer.id, payload);
    await handleAddVendor(organizer.id, payload);
    expect(await prisma.vendor.count({ where: { clientId: "vendor-manual-replay" } })).toBe(1);
  });
});

describe("handleApproveVendor / handleRejectVendor", () => {
  async function pendingVendor(vendorStallFeeCents = 0) {
    const organizer = await createTestUser();
    const applicant = await createTestUser();
    const event = await createTestEvent(organizer.id, undefined, "TZS", {
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
    return { organizer, applicant, event, vendorId: applied.vendor.id };
  }

  it("approves a pending vendor and assigns booth + badge", async () => {
    const { organizer, vendorId } = await pendingVendor();
    const result = await handleApproveVendor(organizer.id, {
      vendorId,
      boothNumber: "A12",
      badgeCode: "VENDR-APPROVE-1",
    });
    expect(result.ok).toBe(true);
    expect(result.vendor.status).toBe("APPROVED");
    expect(result.vendor.boothNumber).toBe("A12");
    expect(result.vendor.badgeCode).toBe("VENDR-APPROVE-1");
  });

  it("refuses to approve a vendor on an event you don't organize", async () => {
    const { vendorId } = await pendingVendor();
    const someoneElse = await createTestUser();
    const result = await handleApproveVendor(someoneElse.id, { vendorId, badgeCode: "VENDR-X" });
    expect(result.ok).toBe(false);
    expect((result as any).reason).toBe("FORBIDDEN");
  });

  it("is idempotent — approving an already-approved vendor just returns it", async () => {
    const { organizer, vendorId } = await pendingVendor();
    await handleApproveVendor(organizer.id, { vendorId, badgeCode: "VENDR-IDEM-1" });
    const second = await handleApproveVendor(organizer.id, { vendorId, badgeCode: "VENDR-IDEM-2" });
    expect(second.ok).toBe(true);
    expect(second.vendor.status).toBe("APPROVED");
    // second call's badge code is ignored — already-approved vendors keep theirs
    expect(second.vendor.badgeCode).toBe("VENDR-IDEM-1");
  });

  it("rejects a pending vendor", async () => {
    const { organizer, vendorId } = await pendingVendor();
    const result = await handleRejectVendor(organizer.id, { vendorId });
    expect(result.ok).toBe(true);
    expect(result.vendor.status).toBe("REJECTED");
  });

  it("refunds a paid fee symbolically on rejection — feeStatus becomes REFUNDED", async () => {
    const { organizer, vendorId } = await pendingVendor(5000);
    const result = await handleRejectVendor(organizer.id, { vendorId });
    expect(result.ok).toBe(true);
    expect(result.vendor.feeStatus).toBe("REFUNDED");
  });

  it("refuses to reject a vendor on an event you don't organize", async () => {
    const { vendorId } = await pendingVendor();
    const someoneElse = await createTestUser();
    const result = await handleRejectVendor(someoneElse.id, { vendorId });
    expect(result.ok).toBe(false);
    expect((result as any).reason).toBe("FORBIDDEN");
  });
});

describe("handleCheckInVendor", () => {
  async function approvedVendor() {
    const organizer = await createTestUser();
    const event = await createTestEvent(organizer.id);
    const added = await handleAddVendor(organizer.id, {
      clientId: `vendor-checkin-${event.id}`,
      eventId: event.id,
      name: "Gate Test Vendor",
      category: "Food",
      badgeCode: `VENDR-CHECKIN-${event.id}`,
    });
    return { organizer, event, badgeCode: added.vendor.badgeCode as string };
  }

  it("checks an approved vendor's badge in", async () => {
    const { badgeCode } = await approvedVendor();
    const result = await handleCheckInVendor({ badgeCode });
    expect(result.ok).toBe(true);
    expect(result.vendor.checkedIn).toBe(true);
  });

  it("reports already-checked-in without erroring on replay", async () => {
    const { badgeCode } = await approvedVendor();
    await handleCheckInVendor({ badgeCode });
    const second = await handleCheckInVendor({ badgeCode });
    expect(second.ok).toBe(true);
    expect((second as any).alreadyCheckedIn).toBe(true);
  });

  it("returns NOT_APPROVED for a badge whose vendor was rejected after approval", async () => {
    // A badge only exists once a vendor is approved — the realistic path to
    // NOT_APPROVED is an organizer reverting that decision afterward, not a
    // badge that was never issued (that's VENDOR_NOT_FOUND instead).
    const { organizer, vendorId } = await (async () => {
      const organizer = await createTestUser();
      const event = await createTestEvent(organizer.id);
      const added = await handleAddVendor(organizer.id, {
        clientId: `vendor-torevoke-${event.id}`,
        eventId: event.id,
        name: "Revoked Vendor",
        category: "Food",
        badgeCode: `VENDR-REVOKE-${event.id}`,
      });
      return { organizer, vendorId: added.vendor.id, badgeCode: added.vendor.badgeCode };
    })();
    const rejected = await handleRejectVendor(organizer.id, { vendorId });

    const result = await handleCheckInVendor({ badgeCode: rejected.vendor.badgeCode });
    expect(result.ok).toBe(false);
    expect((result as any).reason).toBe("NOT_APPROVED");
  });

  it("returns retry:true for an unknown badge code", async () => {
    const result = await handleCheckInVendor({ badgeCode: "VENDR-UNKNOWN" });
    expect(result.ok).toBe(false);
    expect((result as any).retry).toBe(true);
  });
});
