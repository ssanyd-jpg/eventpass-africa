import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { prisma } from "@/lib/prisma";
import {
  createTestEvent,
  createTestUser,
  createTestVendor,
  createTestSponsor,
  createTestWallet,
  createTestOrganization,
  addMembership,
} from "@/lib/test-fixtures";
import {
  handleCreateWallet,
  handleTopupWallet,
  handleCheckTopupStatus,
  handleChargeWallet,
  handleWithdrawWallet,
  handleApproveWithdrawal,
  handleRejectWithdrawal,
  handleSponsorTap,
} from "@/lib/sync-handlers";

// No real Airpay credentials exist in the test environment, so
// getActivePaymentProvider() always resolves to simulatedProvider (instant
// PAID) — mocking it here is the only way to exercise the PENDING/FAILED
// branches handleTopupWallet has to handle for when a real provider is
// eventually configured.
const mockInitiateCharge = vi.fn();
vi.mock("@/lib/payments", () => ({
  getActivePaymentProvider: () => ({
    name: "MOCK",
    isConfigured: () => true,
    initiateCharge: mockInitiateCharge,
  }),
}));

beforeEach(() => {
  mockInitiateCharge.mockReset();
  mockInitiateCharge.mockResolvedValue({ status: "PAID", reference: "MOCK-REF" });
});

// Neon connection-pool drain — several tests in this file chain multiple
// heavy sequential Prisma transactions (e.g. requestedWithdrawal's own
// setup plus two handleRejectWithdrawal/handleApproveWithdrawal calls), and
// under vitest's parallel workers this file has been observed contributing
// to pool exhaustion that surfaces as timeouts elsewhere in the suite. A
// short pause between tests gives Neon's pooler room to release connections
// before the next test's setup starts.
afterEach(async () => {
  await new Promise((resolve) => setTimeout(resolve, 500));
});

describe("handleCreateWallet", () => {
  it("creates a wallet for a LIVE event", async () => {
    const organizer = await createTestUser();
    const organization = await createTestOrganization();
    await addMembership(organization.id, organizer.id);
    const attendee = await createTestUser();
    const event = await createTestEvent(organization.id);

    const result = await handleCreateWallet(attendee.id, {
      clientId: "wallet-client-1",
      code: "WALLET-00001",
      eventId: event.id,
    });

    expect(result.ok).toBe(true);
    expect(result.wallet.balanceCents).toBe(0);
    expect(result.wallet.currency).toBe(event.currency);
  });

  it("is idempotent — replaying the same clientId doesn't create a duplicate wallet", async () => {
    const organizer = await createTestUser();
    const organization = await createTestOrganization();
    await addMembership(organization.id, organizer.id);
    const attendee = await createTestUser();
    const event = await createTestEvent(organization.id);
    const payload = { clientId: "wallet-client-replay", code: "WALLET-00002", eventId: event.id };

    await handleCreateWallet(attendee.id, payload);
    await handleCreateWallet(attendee.id, payload);
    expect(await prisma.wallet.count({ where: { clientId: "wallet-client-replay" } })).toBe(1);
  });

  it("returns the existing wallet rather than violating the one-per-user-per-event constraint", async () => {
    const organizer = await createTestUser();
    const organization = await createTestOrganization();
    await addMembership(organization.id, organizer.id);
    const attendee = await createTestUser();
    const event = await createTestEvent(organization.id);

    const first = await handleCreateWallet(attendee.id, { clientId: "wallet-a", code: "WALLET-A", eventId: event.id });
    const second = await handleCreateWallet(attendee.id, { clientId: "wallet-b", code: "WALLET-B", eventId: event.id });
    expect(second.wallet.id).toBe(first.wallet.id);
  });
});

describe("handleTopupWallet", () => {
  it("credits the balance instantly when the provider returns PAID", async () => {
    const organizer = await createTestUser();
    const organization = await createTestOrganization();
    await addMembership(organization.id, organizer.id);
    const attendee = await createTestUser();
    const event = await createTestEvent(organization.id);
    const wallet = await createTestWallet(event.id, attendee.id, { currency: event.currency });

    const result = await handleTopupWallet(attendee.id, {
      clientId: "topup-paid",
      walletId: wallet.id,
      amountCents: 5000,
    });

    expect(result.ok).toBe(true);
    expect(result.transaction.status).toBe("COMPLETED");
    expect(result.wallet.balanceCents).toBe(5000);
  });

  it("does not touch the balance when the provider returns PENDING", async () => {
    mockInitiateCharge.mockResolvedValue({ status: "PENDING", reference: "MOCK-PENDING-REF" });
    const organizer = await createTestUser();
    const organization = await createTestOrganization();
    await addMembership(organization.id, organizer.id);
    const attendee = await createTestUser();
    const event = await createTestEvent(organization.id);
    const wallet = await createTestWallet(event.id, attendee.id);

    const result = await handleTopupWallet(attendee.id, {
      clientId: "topup-pending",
      walletId: wallet.id,
      amountCents: 5000,
    });

    expect(result.ok).toBe(true);
    expect(result.transaction.status).toBe("PENDING");
    const fresh = await prisma.wallet.findUniqueOrThrow({ where: { id: wallet.id } });
    expect(fresh.balanceCents).toBe(0);
  });

  it("does not touch the balance when the provider returns FAILED", async () => {
    mockInitiateCharge.mockResolvedValue({ status: "FAILED", reference: "", message: "Declined" });
    const organizer = await createTestUser();
    const organization = await createTestOrganization();
    await addMembership(organization.id, organizer.id);
    const attendee = await createTestUser();
    const event = await createTestEvent(organization.id);
    const wallet = await createTestWallet(event.id, attendee.id);

    const result = await handleTopupWallet(attendee.id, {
      clientId: "topup-failed",
      walletId: wallet.id,
      amountCents: 5000,
    });

    expect(result.ok).toBe(true);
    expect(result.transaction.status).toBe("FAILED");
    const fresh = await prisma.wallet.findUniqueOrThrow({ where: { id: wallet.id } });
    expect(fresh.balanceCents).toBe(0);
  });

  it("rejects a top-up on a cancelled event", async () => {
    const organizer = await createTestUser();
    const organization = await createTestOrganization();
    await addMembership(organization.id, organizer.id);
    const attendee = await createTestUser();
    const event = await createTestEvent(organization.id);
    const wallet = await createTestWallet(event.id, attendee.id);
    await prisma.event.update({ where: { id: event.id }, data: { status: "CANCELLED" } });

    const result = await handleTopupWallet(attendee.id, {
      clientId: "topup-cancelled",
      walletId: wallet.id,
      amountCents: 5000,
    });
    expect(result.ok).toBe(false);
    expect((result as any).reason).toBe("EVENT_NOT_LIVE");
  });

  it("is idempotent — replaying the same clientId doesn't double-credit", async () => {
    const organizer = await createTestUser();
    const organization = await createTestOrganization();
    await addMembership(organization.id, organizer.id);
    const attendee = await createTestUser();
    const event = await createTestEvent(organization.id);
    const wallet = await createTestWallet(event.id, attendee.id);
    const payload = { clientId: "topup-replay", walletId: wallet.id, amountCents: 5000 };

    await handleTopupWallet(attendee.id, payload);
    await handleTopupWallet(attendee.id, payload);
    const fresh = await prisma.wallet.findUniqueOrThrow({ where: { id: wallet.id } });
    expect(fresh.balanceCents).toBe(5000);
  });

  it("Session 13: rejects a top-up attempt by anyone other than a group wallet's lead buyer/owner", async () => {
    const organizer = await createTestUser();
    const organization = await createTestOrganization();
    await addMembership(organization.id, organizer.id);
    const lead = await createTestUser();
    const someoneElse = await createTestUser();
    const event = await createTestEvent(organization.id);
    const wallet = await createTestWallet(event.id, lead.id, { currency: event.currency });
    await prisma.wallet.update({ where: { id: wallet.id }, data: { isGroupWallet: true } });
    await prisma.ticketGroup.create({
      data: { name: "Squad", eventId: event.id, leadUserId: lead.id, sharedWalletId: wallet.id },
    });

    const result = await handleTopupWallet(someoneElse.id, {
      clientId: "group-topup-forbidden",
      walletId: wallet.id,
      amountCents: 5000,
    });

    expect(result.ok).toBe(false);
    expect((result as any).reason).toBe("FORBIDDEN");
    const fresh = await prisma.wallet.findUniqueOrThrow({ where: { id: wallet.id } });
    expect(fresh.balanceCents).toBe(0);
  });
});

describe("handleCheckTopupStatus", () => {
  it("is a no-op for a transaction that's already resolved", async () => {
    const organizer = await createTestUser();
    const organization = await createTestOrganization();
    await addMembership(organization.id, organizer.id);
    const attendee = await createTestUser();
    const event = await createTestEvent(organization.id);
    const wallet = await createTestWallet(event.id, attendee.id);
    const topup = await handleTopupWallet(attendee.id, { clientId: "check-resolved", walletId: wallet.id, amountCents: 1000 });

    const result = await handleCheckTopupStatus({ clientId: "check-op-1", walletTransactionId: topup.transaction.id });
    expect(result.ok).toBe(true);
    expect(result.transaction.status).toBe("COMPLETED");
  });
});

describe("handleChargeWallet", () => {
  it("decrements the balance and logs a COMPLETED sale", async () => {
    const organizer = await createTestUser();
    const organization = await createTestOrganization();
    await addMembership(organization.id, organizer.id);
    const attendee = await createTestUser();
    const event = await createTestEvent(organization.id);
    const wallet = await createTestWallet(event.id, attendee.id, { balanceCents: 10000, currency: event.currency });
    const vendor = await createTestVendor(event.id);

    const result = await handleChargeWallet(organizer.id, organization.id, {
      clientId: "charge-1",
      walletCode: wallet.code,
      vendorId: vendor.id,
      amountCents: 4000,
      eventId: event.id,
    });

    expect(result.ok).toBe(true);
    expect(result.transaction.status).toBe("COMPLETED");
    expect(result.wallet.balanceCents).toBe(6000);
  });

  it("declines (not errors) when the balance is insufficient, and leaves the balance unchanged", async () => {
    const organizer = await createTestUser();
    const organization = await createTestOrganization();
    await addMembership(organization.id, organizer.id);
    const attendee = await createTestUser();
    const event = await createTestEvent(organization.id);
    const wallet = await createTestWallet(event.id, attendee.id, { balanceCents: 1000, currency: event.currency });
    const vendor = await createTestVendor(event.id);

    const result = await handleChargeWallet(organizer.id, organization.id, {
      clientId: "charge-insufficient",
      walletCode: wallet.code,
      vendorId: vendor.id,
      amountCents: 5000,
      eventId: event.id,
    });

    expect(result.ok).toBe(true);
    expect((result as any).declined).toBe(true);
    expect(result.transaction.status).toBe("FAILED");
    const fresh = await prisma.wallet.findUniqueOrThrow({ where: { id: wallet.id } });
    expect(fresh.balanceCents).toBe(1000);
  });

  it("never lets a wallet go negative under concurrent charges — exactly one of two simultaneous charges succeeds", async () => {
    const organizer = await createTestUser();
    const organization = await createTestOrganization();
    await addMembership(organization.id, organizer.id);
    const attendee = await createTestUser();
    const event = await createTestEvent(organization.id);
    const wallet = await createTestWallet(event.id, attendee.id, { balanceCents: 5000, currency: event.currency });
    const vendor = await createTestVendor(event.id);

    const [a, b] = await Promise.all([
      handleChargeWallet(organizer.id, organization.id, { clientId: "concurrent-a", walletCode: wallet.code, vendorId: vendor.id, amountCents: 5000, eventId: event.id }),
      handleChargeWallet(organizer.id, organization.id, { clientId: "concurrent-b", walletCode: wallet.code, vendorId: vendor.id, amountCents: 5000, eventId: event.id }),
    ]);

    const outcomes = [a, b].map((r: any) => (r.declined ? "declined" : "completed"));
    expect(outcomes.filter((o) => o === "completed").length).toBe(1);
    expect(outcomes.filter((o) => o === "declined").length).toBe(1);

    const fresh = await prisma.wallet.findUniqueOrThrow({ where: { id: wallet.id } });
    expect(fresh.balanceCents).toBe(0);
  });

  it("refuses to charge against a vendor that isn't approved", async () => {
    const organizer = await createTestUser();
    const organization = await createTestOrganization();
    await addMembership(organization.id, organizer.id);
    const attendee = await createTestUser();
    const event = await createTestEvent(organization.id);
    const wallet = await createTestWallet(event.id, attendee.id, { balanceCents: 10000 });
    const vendor = await createTestVendor(event.id, { status: "PENDING" });

    const result = await handleChargeWallet(organizer.id, organization.id, {
      clientId: "charge-not-approved",
      walletCode: wallet.code,
      vendorId: vendor.id,
      amountCents: 1000,
      eventId: event.id,
    });
    expect(result.ok).toBe(false);
    expect((result as any).reason).toBe("VENDOR_NOT_APPROVED");
  });

  it("rejects a charge on a cancelled event", async () => {
    const organizer = await createTestUser();
    const organization = await createTestOrganization();
    await addMembership(organization.id, organizer.id);
    const attendee = await createTestUser();
    const event = await createTestEvent(organization.id);
    const wallet = await createTestWallet(event.id, attendee.id, { balanceCents: 10000 });
    const vendor = await createTestVendor(event.id);
    await prisma.event.update({ where: { id: event.id }, data: { status: "CANCELLED" } });

    const result = await handleChargeWallet(organizer.id, organization.id, {
      clientId: "charge-cancelled",
      walletCode: wallet.code,
      vendorId: vendor.id,
      amountCents: 1000,
      eventId: event.id,
    });
    expect(result.ok).toBe(false);
    expect((result as any).reason).toBe("EVENT_NOT_LIVE");
  });

  it("is idempotent — replaying the same clientId doesn't double-charge", async () => {
    const organizer = await createTestUser();
    const organization = await createTestOrganization();
    await addMembership(organization.id, organizer.id);
    const attendee = await createTestUser();
    const event = await createTestEvent(organization.id);
    const wallet = await createTestWallet(event.id, attendee.id, { balanceCents: 10000, currency: event.currency });
    const vendor = await createTestVendor(event.id);
    const payload = { clientId: "charge-replay", walletCode: wallet.code, vendorId: vendor.id, amountCents: 2000, eventId: event.id };

    await handleChargeWallet(organizer.id, organization.id, payload);
    await handleChargeWallet(organizer.id, organization.id, payload);
    const fresh = await prisma.wallet.findUniqueOrThrow({ where: { id: wallet.id } });
    expect(fresh.balanceCents).toBe(8000);
  });

  it("rejects a charge against a wallet belonging to a different organization", async () => {
    const organizer = await createTestUser();
    const organization = await createTestOrganization();
    await addMembership(organization.id, organizer.id);
    const attendee = await createTestUser();
    const event = await createTestEvent(organization.id);
    const wallet = await createTestWallet(event.id, attendee.id, { balanceCents: 10000, currency: event.currency });
    const vendor = await createTestVendor(event.id);

    const someoneElse = await createTestUser();
    const someoneElseOrg = await createTestOrganization();
    await addMembership(someoneElseOrg.id, someoneElse.id);

    const result = await handleChargeWallet(someoneElse.id, someoneElseOrg.id, {
      clientId: "charge-cross-org",
      walletCode: wallet.code,
      vendorId: vendor.id,
      amountCents: 1000,
      eventId: event.id,
    });
    expect(result.ok).toBe(false);
    expect((result as any).reason).toBe("FORBIDDEN");
  });

  it("rejects a replayed charge against a wallet belonging to a different organization", async () => {
    const organizer = await createTestUser();
    const organization = await createTestOrganization();
    await addMembership(organization.id, organizer.id);
    const attendee = await createTestUser();
    const event = await createTestEvent(organization.id);
    const wallet = await createTestWallet(event.id, attendee.id, { balanceCents: 10000, currency: event.currency });
    const vendor = await createTestVendor(event.id);
    const payload = { clientId: "charge-replay-cross-org", walletCode: wallet.code, vendorId: vendor.id, amountCents: 1000, eventId: event.id };

    await handleChargeWallet(organizer.id, organization.id, payload);

    const someoneElse = await createTestUser();
    const someoneElseOrg = await createTestOrganization();
    await addMembership(someoneElseOrg.id, someoneElse.id);

    const result = await handleChargeWallet(someoneElse.id, someoneElseOrg.id, payload);
    expect(result.ok).toBe(false);
    expect((result as any).reason).toBe("FORBIDDEN");
  });

  it("Session 13: attributes a charge on a group wallet to the specific member via attendeeTicketId, still deducting from the shared balance", async () => {
    const organizer = await createTestUser();
    const organization = await createTestOrganization();
    await addMembership(organization.id, organizer.id);
    const lead = await createTestUser();
    const event = await createTestEvent(organization.id);
    const wallet = await createTestWallet(event.id, lead.id, { balanceCents: 10000, currency: event.currency });
    await prisma.wallet.update({ where: { id: wallet.id }, data: { isGroupWallet: true } });
    const group = await prisma.ticketGroup.create({
      data: { name: "Squad", eventId: event.id, leadUserId: lead.id, sharedWalletId: wallet.id },
    });
    const tt = await prisma.ticketType.findFirstOrThrow({ where: { eventId: event.id } });
    const order = await prisma.order.create({
      data: { clientId: "group-charge-order", status: "PAID", totalCents: 0, currency: event.currency, userId: lead.id, eventId: event.id },
    });
    const ticket = await prisma.ticket.create({
      data: { code: "MEMBER-TICKET-1", eventId: event.id, ticketTypeId: tt.id, orderId: order.id, ticketGroupId: group.id, groupMemberName: "Kesi" },
    });
    const vendor = await createTestVendor(event.id);

    const result: any = await handleChargeWallet(organizer.id, organization.id, {
      clientId: "group-charge-1",
      walletCode: wallet.code,
      vendorId: vendor.id,
      amountCents: 3000,
      eventId: event.id,
      attendeeTicketId: ticket.id,
    });

    expect(result.ok).toBe(true);
    expect(result.transaction.status).toBe("COMPLETED");
    expect(result.transaction.spentByTicketId).toBe(ticket.id);
    expect(result.transaction.spentByMemberName).toBe("Kesi");
    expect(result.wallet.balanceCents).toBe(7000);
  });

  it("Session 13: ignores an attendeeTicketId that doesn't belong to this wallet's group", async () => {
    const organizer = await createTestUser();
    const organization = await createTestOrganization();
    await addMembership(organization.id, organizer.id);
    const lead = await createTestUser();
    const event = await createTestEvent(organization.id);
    const wallet = await createTestWallet(event.id, lead.id, { balanceCents: 10000, currency: event.currency });
    await prisma.wallet.update({ where: { id: wallet.id }, data: { isGroupWallet: true } });
    await prisma.ticketGroup.create({
      data: { name: "Squad", eventId: event.id, leadUserId: lead.id, sharedWalletId: wallet.id },
    });
    const tt = await prisma.ticketType.findFirstOrThrow({ where: { eventId: event.id } });
    const otherOrder = await prisma.order.create({
      data: { clientId: "unrelated-order", status: "PAID", totalCents: 0, currency: event.currency, userId: lead.id, eventId: event.id },
    });
    const unrelatedTicket = await prisma.ticket.create({
      data: { code: "UNRELATED-1", eventId: event.id, ticketTypeId: tt.id, orderId: otherOrder.id },
    });
    const vendor = await createTestVendor(event.id);

    const result: any = await handleChargeWallet(organizer.id, organization.id, {
      clientId: "group-charge-2",
      walletCode: wallet.code,
      vendorId: vendor.id,
      amountCents: 3000,
      eventId: event.id,
      attendeeTicketId: unrelatedTicket.id,
    });

    expect(result.ok).toBe(true);
    expect(result.transaction.spentByTicketId).toBeNull();
    expect(result.transaction.spentByMemberName).toBeNull();
  });
});

describe("handleWithdrawWallet", () => {
  it("decrements the balance and creates a PENDING withdrawal", async () => {
    const organizer = await createTestUser();
    const organization = await createTestOrganization();
    await addMembership(organization.id, organizer.id);
    const attendee = await createTestUser();
    const event = await createTestEvent(organization.id);
    const wallet = await createTestWallet(event.id, attendee.id, { balanceCents: 10000, currency: event.currency });

    const result = await handleWithdrawWallet(attendee.id, {
      clientId: "withdraw-1",
      walletId: wallet.id,
      amountCents: 4000,
      phoneNumber: "0712345678",
      mobileNetwork: "MPESA",
    });

    expect(result.ok).toBe(true);
    expect((result as any).transaction.type).toBe("WITHDRAWAL");
    expect((result as any).transaction.status).toBe("PENDING");
    expect((result as any).transaction.mobileNetwork).toBe("MPESA");
    expect((result as any).wallet.balanceCents).toBe(6000);
    const fresh = await prisma.wallet.findUniqueOrThrow({ where: { id: wallet.id } });
    expect(fresh.balanceCents).toBe(6000);
  });

  it("declines (not errors) when the balance is insufficient, and leaves the balance unchanged", async () => {
    const organizer = await createTestUser();
    const organization = await createTestOrganization();
    await addMembership(organization.id, organizer.id);
    const attendee = await createTestUser();
    const event = await createTestEvent(organization.id);
    const wallet = await createTestWallet(event.id, attendee.id, { balanceCents: 1000, currency: event.currency });

    const result = await handleWithdrawWallet(attendee.id, {
      clientId: "withdraw-insufficient",
      walletId: wallet.id,
      amountCents: 5000,
      phoneNumber: "0712345678",
      mobileNetwork: "MPESA",
    });

    expect(result.ok).toBe(true);
    expect((result as any).declined).toBe(true);
    expect((result as any).reason).toBe("INSUFFICIENT_BALANCE");
    expect((result as any).transaction.status).toBe("FAILED");
    const fresh = await prisma.wallet.findUniqueOrThrow({ where: { id: wallet.id } });
    expect(fresh.balanceCents).toBe(1000);
  });

  it("is idempotent — replaying the same clientId doesn't double-decrement", async () => {
    const organizer = await createTestUser();
    const organization = await createTestOrganization();
    await addMembership(organization.id, organizer.id);
    const attendee = await createTestUser();
    const event = await createTestEvent(organization.id);
    const wallet = await createTestWallet(event.id, attendee.id, { balanceCents: 10000, currency: event.currency });
    const payload = { clientId: "withdraw-replay", walletId: wallet.id, amountCents: 2000, phoneNumber: "0712345678", mobileNetwork: "MPESA" };

    await handleWithdrawWallet(attendee.id, payload);
    await handleWithdrawWallet(attendee.id, payload);
    const fresh = await prisma.wallet.findUniqueOrThrow({ where: { id: wallet.id } });
    expect(fresh.balanceCents).toBe(8000);
  });

  it("rejects a withdrawal request for a wallet owned by someone else", async () => {
    const organizer = await createTestUser();
    const organization = await createTestOrganization();
    await addMembership(organization.id, organizer.id);
    const attendee = await createTestUser();
    const someoneElse = await createTestUser();
    const event = await createTestEvent(organization.id);
    const wallet = await createTestWallet(event.id, attendee.id, { balanceCents: 10000 });

    const result = await handleWithdrawWallet(someoneElse.id, {
      clientId: "withdraw-not-owner",
      walletId: wallet.id,
      amountCents: 1000,
      phoneNumber: "0712345678",
      mobileNetwork: "MPESA",
    });
    expect(result.ok).toBe(false);
    expect((result as any).reason).toBe("FORBIDDEN");
  });

  it("notifies the org OWNER when a withdrawal is requested", async () => {
    const organizer = await createTestUser({ email: `owner-${Date.now()}@test.local` });
    const organization = await createTestOrganization();
    await addMembership(organization.id, organizer.id, "OWNER");
    const attendee = await createTestUser();
    const event = await createTestEvent(organization.id);
    const wallet = await createTestWallet(event.id, attendee.id, { balanceCents: 10000 });

    await handleWithdrawWallet(attendee.id, {
      clientId: "withdraw-notify",
      walletId: wallet.id,
      amountCents: 1000,
      phoneNumber: "0712345678",
      mobileNetwork: "MPESA",
    });

    const log = await prisma.notificationLog.findFirstOrThrow({
      where: { type: "WITHDRAWAL_REQUESTED", recipient: organizer.email },
      orderBy: { createdAt: "desc" },
    });
    expect(log.subject).toContain("withdrawal request");
  });
});

describe("handleApproveWithdrawal", () => {
  async function requestedWithdrawal(balanceCents = 10000, amountCents = 4000) {
    const organizer = await createTestUser();
    const organization = await createTestOrganization();
    await addMembership(organization.id, organizer.id, "OWNER");
    const attendee = await createTestUser();
    const event = await createTestEvent(organization.id);
    const wallet = await createTestWallet(event.id, attendee.id, { balanceCents, currency: event.currency });
    const withdrawal = await handleWithdrawWallet(attendee.id, {
      clientId: `withdraw-${Date.now()}-${Math.random()}`,
      walletId: wallet.id,
      amountCents,
      phoneNumber: "0712345678",
      mobileNetwork: "MPESA",
    });
    return { organizer, organizationId: organization.id, attendee, event, wallet, withdrawal };
  }

  it("marks a PENDING withdrawal COMPLETED and notifies the buyer", async () => {
    const { organizer, organizationId, attendee, withdrawal } = await requestedWithdrawal();

    const result = await handleApproveWithdrawal(organizer.id, organizationId, {
      clientId: "approve-1",
      walletTransactionId: (withdrawal as any).transaction.id,
    });

    expect(result.ok).toBe(true);
    expect((result as any).transaction.status).toBe("COMPLETED");
    const log = await prisma.notificationLog.findFirstOrThrow({
      where: { type: "WITHDRAWAL_DECIDED", recipient: attendee.email },
      orderBy: { createdAt: "desc" },
    });
    expect(log.subject).toContain("paid");
  });

  it("rejects approval of a withdrawal belonging to a different organization", async () => {
    const { withdrawal } = await requestedWithdrawal();
    const someoneElse = await createTestUser();
    const someoneElseOrg = await createTestOrganization();
    await addMembership(someoneElseOrg.id, someoneElse.id);

    const result = await handleApproveWithdrawal(someoneElse.id, someoneElseOrg.id, {
      clientId: "approve-cross-org",
      walletTransactionId: (withdrawal as any).transaction.id,
    });
    expect(result.ok).toBe(false);
    expect((result as any).reason).toBe("FORBIDDEN");
  });

  it("is idempotent — approving an already-COMPLETED withdrawal is a no-op", async () => {
    const { organizer, organizationId, attendee, withdrawal } = await requestedWithdrawal();
    const walletTransactionId = (withdrawal as any).transaction.id;

    await handleApproveWithdrawal(organizer.id, organizationId, { clientId: "approve-a", walletTransactionId });
    const second = await handleApproveWithdrawal(organizer.id, organizationId, { clientId: "approve-b", walletTransactionId });

    expect(second.ok).toBe(true);
    expect((second as any).transaction.status).toBe("COMPLETED");
    // Scoped to this specific buyer, not a global count — the shared test
    // DB accumulates WITHDRAWAL_DECIDED notifications from every other
    // test in this file (including handleRejectWithdrawal's own tests),
    // so an unscoped count would be flaky/order-dependent.
    expect(await prisma.notificationLog.count({ where: { type: "WITHDRAWAL_DECIDED", recipient: attendee.email } })).toBe(1);
  });
});

describe("handleRejectWithdrawal", () => {
  async function requestedWithdrawal(balanceCents = 10000, amountCents = 4000) {
    const organizer = await createTestUser();
    const organization = await createTestOrganization();
    await addMembership(organization.id, organizer.id, "OWNER");
    const attendee = await createTestUser();
    const event = await createTestEvent(organization.id);
    const wallet = await createTestWallet(event.id, attendee.id, { balanceCents, currency: event.currency });
    const withdrawal = await handleWithdrawWallet(attendee.id, {
      clientId: `withdraw-${Date.now()}-${Math.random()}`,
      walletId: wallet.id,
      amountCents,
      phoneNumber: "0712345678",
      mobileNetwork: "MPESA",
    });
    return { organizer, organizationId: organization.id, attendee, event, wallet, withdrawal };
  }

  it("marks a PENDING withdrawal FAILED, stores the reason, and refunds the balance", async () => {
    const { organizer, organizationId, wallet, withdrawal } = await requestedWithdrawal(10000, 4000);

    const result = await handleRejectWithdrawal(organizer.id, organizationId, {
      clientId: "reject-1",
      walletTransactionId: (withdrawal as any).transaction.id,
      reason: "Phone number looked wrong",
    });

    expect(result.ok).toBe(true);
    expect((result as any).transaction.status).toBe("FAILED");
    expect((result as any).transaction.providerMessage).toBe("Phone number looked wrong");
    expect((result as any).wallet.balanceCents).toBe(10000);
    const fresh = await prisma.wallet.findUniqueOrThrow({ where: { id: wallet.id } });
    expect(fresh.balanceCents).toBe(10000);
  });

  it("rejects rejection of a withdrawal belonging to a different organization", async () => {
    const { withdrawal } = await requestedWithdrawal();
    const someoneElse = await createTestUser();
    const someoneElseOrg = await createTestOrganization();
    await addMembership(someoneElseOrg.id, someoneElse.id);

    const result = await handleRejectWithdrawal(someoneElse.id, someoneElseOrg.id, {
      clientId: "reject-cross-org",
      walletTransactionId: (withdrawal as any).transaction.id,
    });
    expect(result.ok).toBe(false);
    expect((result as any).reason).toBe("FORBIDDEN");
  });

  // Neon latency headroom — requestedWithdrawal's own setup plus two
  // sequential handleRejectWithdrawal transactions has been observed timing
  // out at the default 60s under sustained load; 120s gives it room without
  // masking a genuine hang (see vitest.global-setup.ts's own warm-up-query
  // comment, which explains why Neon's compute can add several seconds of
  // cold-start latency to the first real query against it).
  it("is idempotent — rejecting an already-FAILED withdrawal does not double-refund", { timeout: 120000 }, async () => {
    const { organizer, organizationId, wallet, withdrawal } = await requestedWithdrawal(10000, 4000);
    const walletTransactionId = (withdrawal as any).transaction.id;

    await handleRejectWithdrawal(organizer.id, organizationId, { clientId: "reject-a", walletTransactionId });
    await handleRejectWithdrawal(organizer.id, organizationId, { clientId: "reject-b", walletTransactionId });

    const fresh = await prisma.wallet.findUniqueOrThrow({ where: { id: wallet.id } });
    // Balance started at 10000, withdrawal reserved 4000 (-> 6000), a single
    // refund must bring it back to exactly 10000 — NOT 14000 from a double
    // refund. This is the sharpest test in the whole feature.
    expect(fresh.balanceCents).toBe(10000);
  });
});

describe("handleSponsorTap", () => {
  it("logs a tap with no balance change", async () => {
    const organizer = await createTestUser();
    const organization = await createTestOrganization();
    await addMembership(organization.id, organizer.id);
    const attendee = await createTestUser();
    const event = await createTestEvent(organization.id);
    const wallet = await createTestWallet(event.id, attendee.id, { balanceCents: 5000 });
    const sponsor = await createTestSponsor(event.id, { name: "Red Bull Stage" });

    const result = await handleSponsorTap(organizer.id, organization.id, {
      clientId: "tap-1",
      walletCode: wallet.code,
      sponsorId: sponsor.id,
      eventId: event.id,
    });

    expect(result.ok).toBe(true);
    expect(result.transaction.amountCents).toBeNull();
    expect(result.transaction.sponsorId).toBe(sponsor.id);
    const fresh = await prisma.wallet.findUniqueOrThrow({ where: { id: wallet.id } });
    expect(fresh.balanceCents).toBe(5000);
  });

  it("is idempotent — replaying the same clientId doesn't create a duplicate tap", async () => {
    const organizer = await createTestUser();
    const organization = await createTestOrganization();
    await addMembership(organization.id, organizer.id);
    const attendee = await createTestUser();
    const event = await createTestEvent(organization.id);
    const wallet = await createTestWallet(event.id, attendee.id);
    const sponsor = await createTestSponsor(event.id, { name: "MTN Booth" });
    // Unique per run, not a bare literal — this exact literal used to
    // collide with an identically-named clientId in sync-handlers.test.ts's
    // own handleSponsorTap idempotent-replay test (WalletTransaction.clientId
    // is globally unique and both files share one test DB within a single
    // `npm test` run) — see that test's comment for the full story.
    const clientId = `tap-replay-${Date.now()}-${Math.random()}`;
    const payload = { clientId, walletCode: wallet.code, sponsorId: sponsor.id, eventId: event.id };

    await handleSponsorTap(organizer.id, organization.id, payload);
    await handleSponsorTap(organizer.id, organization.id, payload);
    expect(await prisma.walletTransaction.count({ where: { clientId } })).toBe(1);
  });

  it("rejects a tap against a wallet belonging to a different organization", async () => {
    const organizer = await createTestUser();
    const organization = await createTestOrganization();
    await addMembership(organization.id, organizer.id);
    const attendee = await createTestUser();
    const event = await createTestEvent(organization.id);
    const wallet = await createTestWallet(event.id, attendee.id);
    const sponsor = await createTestSponsor(event.id, { name: "Interloper Booth" });

    const someoneElse = await createTestUser();
    const someoneElseOrg = await createTestOrganization();
    await addMembership(someoneElseOrg.id, someoneElse.id);

    const result = await handleSponsorTap(someoneElse.id, someoneElseOrg.id, {
      clientId: "tap-cross-org",
      walletCode: wallet.code,
      sponsorId: sponsor.id,
      eventId: event.id,
    });
    expect(result.ok).toBe(false);
    expect((result as any).reason).toBe("FORBIDDEN");
  });

  it("rejects a replayed tap against a wallet belonging to a different organization", async () => {
    const organizer = await createTestUser();
    const organization = await createTestOrganization();
    await addMembership(organization.id, organizer.id);
    const attendee = await createTestUser();
    const event = await createTestEvent(organization.id);
    const wallet = await createTestWallet(event.id, attendee.id);
    const sponsor = await createTestSponsor(event.id, { name: "MTN Booth" });
    const payload = { clientId: "tap-replay-cross-org", walletCode: wallet.code, sponsorId: sponsor.id, eventId: event.id };

    await handleSponsorTap(organizer.id, organization.id, payload);

    const someoneElse = await createTestUser();
    const someoneElseOrg = await createTestOrganization();
    await addMembership(someoneElseOrg.id, someoneElse.id);

    const result = await handleSponsorTap(someoneElse.id, someoneElseOrg.id, payload);
    expect(result.ok).toBe(false);
    expect((result as any).reason).toBe("FORBIDDEN");
  });

  it("rejects a tap when the sponsor belongs to a different event", async () => {
    const organizer = await createTestUser();
    const organization = await createTestOrganization();
    await addMembership(organization.id, organizer.id);
    const attendee = await createTestUser();
    const event = await createTestEvent(organization.id);
    const otherEvent = await createTestEvent(organization.id);
    const wallet = await createTestWallet(event.id, attendee.id);
    const sponsorFromOtherEvent = await createTestSponsor(otherEvent.id, { name: "Wrong Event Sponsor" });

    const result = await handleSponsorTap(organizer.id, organization.id, {
      clientId: "tap-event-mismatch",
      walletCode: wallet.code,
      sponsorId: sponsorFromOtherEvent.id,
      eventId: event.id,
    });
    expect(result.ok).toBe(false);
    expect((result as any).reason).toBe("SPONSOR_EVENT_MISMATCH");
  });

  it("returns retry:true when the sponsor hasn't synced yet", async () => {
    const organizer = await createTestUser();
    const organization = await createTestOrganization();
    await addMembership(organization.id, organizer.id);
    const attendee = await createTestUser();
    const event = await createTestEvent(organization.id);
    const wallet = await createTestWallet(event.id, attendee.id);

    const result = await handleSponsorTap(organizer.id, organization.id, {
      clientId: "tap-sponsor-unsynced",
      walletCode: wallet.code,
      sponsorId: "does-not-exist",
      eventId: event.id,
    });
    expect(result.ok).toBe(false);
    expect((result as any).retry).toBe(true);
    expect((result as any).reason).toBe("SPONSOR_NOT_SYNCED_YET");
  });
});
