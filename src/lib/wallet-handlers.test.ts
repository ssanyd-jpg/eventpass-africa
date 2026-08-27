import { describe, expect, it, vi, beforeEach } from "vitest";
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
    const payload = { clientId: "tap-replay", walletCode: wallet.code, sponsorId: sponsor.id, eventId: event.id };

    await handleSponsorTap(organizer.id, organization.id, payload);
    await handleSponsorTap(organizer.id, organization.id, payload);
    expect(await prisma.walletTransaction.count({ where: { clientId: "tap-replay" } })).toBe(1);
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
