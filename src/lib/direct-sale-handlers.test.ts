import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { prisma } from "@/lib/prisma";
import { createTestEvent, createTestUser, createTestOrganization, addMembership } from "@/lib/test-fixtures";
import { handleChargeDirectSale, handleCheckDirectSaleStatus, handleCancelDirectSale } from "@/lib/sync-handlers";

// Session 28 — same two-mock pattern as wallet-handlers.test.ts: initiateCharge
// goes through getActivePaymentProvider(), verifyAirpayOrder is imported
// directly from @/lib/payments/airpay, so the poll-resolved branch needs its
// own separate mock.
const { mockInitiateCharge, mockVerifyAirpayOrder } = vi.hoisted(() => ({
  mockInitiateCharge: vi.fn(),
  mockVerifyAirpayOrder: vi.fn(),
}));
vi.mock("@/lib/payments", () => ({
  getActivePaymentProvider: () => ({
    name: "MOCK",
    isConfigured: () => true,
    initiateCharge: mockInitiateCharge,
  }),
}));
vi.mock("@/lib/payments/airpay", () => ({
  verifyAirpayOrder: mockVerifyAirpayOrder,
}));

beforeEach(() => {
  mockInitiateCharge.mockReset();
  mockInitiateCharge.mockResolvedValue({ status: "PAID", reference: "MOCK-REF" });
  mockVerifyAirpayOrder.mockReset();
});

// Same Neon connection-pool drain as wallet-handlers.test.ts.
afterEach(async () => {
  await new Promise((resolve) => setTimeout(resolve, 500));
});

async function setup() {
  const staff = await createTestUser();
  const organization = await createTestOrganization();
  await addMembership(organization.id, staff.id);
  const event = await createTestEvent(organization.id);
  return { staff, organization, event };
}

describe("handleChargeDirectSale", () => {
  it("confirms instantly and sets airpayRef when the provider returns PAID", async () => {
    const { staff, organization, event } = await setup();

    const result = await handleChargeDirectSale(staff.id, organization.id, {
      clientId: "ds-paid-1",
      eventId: event.id,
      amountCents: 5000,
      customerPhone: "0700000001",
      mobileNetwork: "MPESA",
    });

    expect(result.ok).toBe(true);
    expect(result.transaction.status).toBe("CONFIRMED");
    expect(result.transaction.airpayRef).toBe("MOCK-REF");
    expect(result.transaction.vendorUserId).toBe(staff.id);
    expect(result.transaction.resolvedAt).not.toBeNull();
  });

  it("leaves it PENDING with no airpayRef when the provider returns PENDING", async () => {
    mockInitiateCharge.mockResolvedValue({ status: "PENDING", reference: "MOCK-PENDING-REF" });
    const { staff, organization, event } = await setup();

    const result = await handleChargeDirectSale(staff.id, organization.id, {
      clientId: "ds-pending-1",
      eventId: event.id,
      amountCents: 5000,
      customerPhone: "0700000002",
      mobileNetwork: "TIGO",
    });

    expect(result.ok).toBe(true);
    expect(result.transaction.status).toBe("PENDING");
    expect(result.transaction.airpayRef).toBeNull();
    expect(result.transaction.resolvedAt).toBeNull();
  });

  it("records a FAILED row when the provider declines outright", async () => {
    mockInitiateCharge.mockResolvedValue({ status: "FAILED", reference: "", message: "Invalid number" });
    const { staff, organization, event } = await setup();

    const result = await handleChargeDirectSale(staff.id, organization.id, {
      clientId: "ds-failed-1",
      eventId: event.id,
      amountCents: 5000,
      customerPhone: "0700000003",
      mobileNetwork: "AIRTEL",
    });

    expect(result.ok).toBe(true);
    expect(result.transaction.status).toBe("FAILED");
    expect(result.transaction.providerMessage).toBe("Invalid number");
  });

  it("is idempotent — replaying the same clientId returns the existing row rather than double-charging", async () => {
    const { staff, organization, event } = await setup();
    const payload = {
      clientId: "ds-replay-1",
      eventId: event.id,
      amountCents: 5000,
      customerPhone: "0700000004",
      mobileNetwork: "MPESA",
    };

    await handleChargeDirectSale(staff.id, organization.id, payload);
    await handleChargeDirectSale(staff.id, organization.id, payload);

    expect(mockInitiateCharge).toHaveBeenCalledTimes(1);
    expect(await prisma.directSaleTransaction.count({ where: { clientId: "ds-replay-1" } })).toBe(1);
  });

  it("rejects a charge against another organization's event", async () => {
    const { staff, event } = await setup();
    const otherOrg = await createTestOrganization();

    const result = await handleChargeDirectSale(staff.id, otherOrg.id, {
      clientId: "ds-forbidden-1",
      eventId: event.id,
      amountCents: 5000,
      customerPhone: "0700000005",
      mobileNetwork: "MPESA",
    });

    expect(result.ok).toBe(false);
    expect(result.reason).toBe("FORBIDDEN");
  });

  it("rejects a charge against a non-LIVE event", async () => {
    const { staff, organization, event } = await setup();
    await prisma.event.update({ where: { id: event.id }, data: { status: "DRAFT" } });

    const result = await handleChargeDirectSale(staff.id, organization.id, {
      clientId: "ds-not-live-1",
      eventId: event.id,
      amountCents: 5000,
      customerPhone: "0700000006",
      mobileNetwork: "MPESA",
    });

    expect(result.ok).toBe(false);
    expect(result.reason).toBe("EVENT_NOT_LIVE");
  });
});

describe("handleCheckDirectSaleStatus", () => {
  it("is a no-op for a transaction that's already resolved — never re-polls AirPay", async () => {
    const { staff, organization, event } = await setup();
    const charge = await handleChargeDirectSale(staff.id, organization.id, {
      clientId: "ds-check-resolved",
      eventId: event.id,
      amountCents: 3000,
      customerPhone: "0700000007",
      mobileNetwork: "MPESA",
    });

    const result = await handleCheckDirectSaleStatus({ directSaleId: charge.transaction.id });
    expect(result.ok).toBe(true);
    expect(result.transaction.status).toBe("CONFIRMED");
    expect(mockVerifyAirpayOrder).not.toHaveBeenCalled();
  });

  it("confirms a PENDING sale that AirPay reports as PAID, setting airpayRef", async () => {
    mockInitiateCharge.mockResolvedValue({ status: "PENDING", reference: "MOCK-PENDING-REF" });
    const { staff, organization, event } = await setup();
    const charge = await handleChargeDirectSale(staff.id, organization.id, {
      clientId: "ds-check-paid",
      eventId: event.id,
      amountCents: 3000,
      customerPhone: "0700000008",
      mobileNetwork: "MPESA",
    });
    expect(charge.transaction.status).toBe("PENDING");

    mockVerifyAirpayOrder.mockResolvedValue({ status: "PAID", reference: "MOCK-CONFIRMED-REF" });
    const result = await handleCheckDirectSaleStatus({ directSaleId: charge.transaction.id });

    expect(result.ok).toBe(true);
    expect(result.transaction.status).toBe("CONFIRMED");
    expect(result.transaction.airpayRef).toBe("MOCK-CONFIRMED-REF");
  });

  it("marks a PENDING sale FAILED when AirPay reports it declined", async () => {
    mockInitiateCharge.mockResolvedValue({ status: "PENDING", reference: "MOCK-PENDING-REF" });
    const { staff, organization, event } = await setup();
    const charge = await handleChargeDirectSale(staff.id, organization.id, {
      clientId: "ds-check-failed",
      eventId: event.id,
      amountCents: 3000,
      customerPhone: "0700000009",
      mobileNetwork: "MPESA",
    });

    mockVerifyAirpayOrder.mockResolvedValue({ status: "FAILED", message: "Buyer cancelled" });
    const result = await handleCheckDirectSaleStatus({ directSaleId: charge.transaction.id });

    expect(result.ok).toBe(true);
    expect(result.transaction.status).toBe("FAILED");
    expect(result.transaction.providerMessage).toBe("Buyer cancelled");
  });

  it("stays PENDING and returns retry when AirPay is still PENDING", async () => {
    mockInitiateCharge.mockResolvedValue({ status: "PENDING", reference: "MOCK-PENDING-REF" });
    const { staff, organization, event } = await setup();
    const charge = await handleChargeDirectSale(staff.id, organization.id, {
      clientId: "ds-check-still-pending",
      eventId: event.id,
      amountCents: 3000,
      customerPhone: "0700000010",
      mobileNetwork: "MPESA",
    });

    mockVerifyAirpayOrder.mockResolvedValue({ status: "PENDING" });
    const result = await handleCheckDirectSaleStatus({ directSaleId: charge.transaction.id });

    expect(result.ok).toBe(true);
    expect(result.transaction.status).toBe("PENDING");
  });

  it("asks for a retry when the transaction hasn't synced yet", async () => {
    const result = await handleCheckDirectSaleStatus({ directSaleId: "not-a-real-id" });
    expect(result.ok).toBe(false);
    expect(result.retry).toBe(true);
  });
});

describe("handleCancelDirectSale", () => {
  it("cancels a PENDING sale", async () => {
    mockInitiateCharge.mockResolvedValue({ status: "PENDING", reference: "MOCK-PENDING-REF" });
    const { staff, organization, event } = await setup();
    const charge = await handleChargeDirectSale(staff.id, organization.id, {
      clientId: "ds-cancel-1",
      eventId: event.id,
      amountCents: 3000,
      customerPhone: "0700000011",
      mobileNetwork: "MPESA",
    });

    const result = await handleCancelDirectSale(staff.id, { directSaleId: charge.transaction.id });
    expect(result.ok).toBe(true);
    expect(result.transaction.status).toBe("CANCELLED");
  });

  it("refuses to cancel another staff member's direct sale", async () => {
    mockInitiateCharge.mockResolvedValue({ status: "PENDING", reference: "MOCK-PENDING-REF" });
    const { staff, organization, event } = await setup();
    const otherStaff = await createTestUser();
    const charge = await handleChargeDirectSale(staff.id, organization.id, {
      clientId: "ds-cancel-forbidden",
      eventId: event.id,
      amountCents: 3000,
      customerPhone: "0700000012",
      mobileNetwork: "MPESA",
    });

    const result = await handleCancelDirectSale(otherStaff.id, { directSaleId: charge.transaction.id });
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("FORBIDDEN");
  });

  it("is idempotent on a transaction that's already CONFIRMED — leaves it untouched", async () => {
    const { staff, organization, event } = await setup();
    const charge = await handleChargeDirectSale(staff.id, organization.id, {
      clientId: "ds-cancel-noop",
      eventId: event.id,
      amountCents: 3000,
      customerPhone: "0700000013",
      mobileNetwork: "MPESA",
    });
    expect(charge.transaction.status).toBe("CONFIRMED");

    const result = await handleCancelDirectSale(staff.id, { directSaleId: charge.transaction.id });
    expect(result.ok).toBe(true);
    expect(result.transaction.status).toBe("CONFIRMED");
  });
});
