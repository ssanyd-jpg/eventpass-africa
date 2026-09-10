import { describe, expect, it } from "vitest";
import { prisma } from "@/lib/prisma";
import {
  createTestUser,
  createTestOrganization,
  addMembership,
  createTestEvent,
  createTestVendor,
  createTestWallet,
} from "@/lib/test-fixtures";
import { handleSellTickets, handleChargeWallet } from "@/lib/sync-handlers";
import {
  computeVariance,
  classifyVariance,
  getReconciliationData,
  getOperatorFloat,
  saveFloatDeclarationCore,
  buildReconciliationCsvSections,
  MINOR_VARIANCE_THRESHOLD_CENTS,
} from "@/lib/reconciliation";

let seq = 0;
const uid = (p: string) => `${p}-${Date.now()}-${++seq}`;

async function newOrganizer() {
  const user = await createTestUser();
  const organization = await createTestOrganization();
  await addMembership(organization.id, user.id, "OWNER");
  return { user, organizationId: organization.id };
}

// A cash (OFFLINE_DEFERRED) door sale recorded by `operatorId` — one ticket
// at the event's default 200000-cent price.
async function cashSale(operatorId: string, event: { id: string; ticketTypes: { id: string }[] }) {
  return handleSellTickets(operatorId, {
    clientId: uid("cash-order"),
    eventId: event.id,
    items: [{ ticketTypeId: event.ticketTypes[0].id, quantity: 1, codes: [uid("code")] }],
    paymentMethod: "OFFLINE_DEFERRED",
  });
}

describe("computeVariance / classifyVariance", () => {
  it("is BALANCED only at exactly zero variance", () => {
    expect(computeVariance(100_000, 100_000)).toBe(0);
    expect(classifyVariance(0)).toBe("BALANCED");
  });

  it("is MINOR_VARIANCE for a non-zero variance under the TZS 5,000 threshold, either direction", () => {
    expect(classifyVariance(computeVariance(600_000, 550_000))).toBe("MINOR_VARIANCE"); // +50,000 short
    expect(classifyVariance(computeVariance(100_000, 150_000))).toBe("MINOR_VARIANCE"); // -50,000 over
    expect(classifyVariance(MINOR_VARIANCE_THRESHOLD_CENTS - 1)).toBe("MINOR_VARIANCE");
  });

  it("is INVESTIGATE at or over the threshold", () => {
    expect(classifyVariance(MINOR_VARIANCE_THRESHOLD_CENTS)).toBe("INVESTIGATE");
    expect(classifyVariance(computeVariance(1_000_000, 400_000))).toBe("INVESTIGATE"); // +600,000 short
    expect(classifyVariance(-MINOR_VARIANCE_THRESHOLD_CENTS)).toBe("INVESTIGATE");
  });
});

describe("saveFloatDeclarationCore", () => {
  it("saves a declaration with the recomputed system total, variance and status", async () => {
    const { user: organiser, organizationId } = await newOrganizer();
    const event = await createTestEvent(organizationId);
    const operator = await createTestUser({ name: "Cash Op" });
    await cashSale(operator.id, event);
    await cashSale(operator.id, event); // system total = 400,000

    const result = await saveFloatDeclarationCore({
      eventId: event.id,
      operatorId: operator.id,
      declaredAmountCents: 398_000,
      declaredByUserId: organiser.id,
    });
    expect(result.systemTotalCents).toBe(400_000);
    expect(result.varianceCents).toBe(2_000);
    expect(result.status).toBe("MINOR_VARIANCE");

    const row = await prisma.floatDeclaration.findUniqueOrThrow({
      where: { eventId_operatorId: { eventId: event.id, operatorId: operator.id } },
    });
    expect(row.declaredAmountCents).toBe(398_000);
    expect(row.varianceCents).toBe(2_000);
    expect(row.status).toBe("MINOR_VARIANCE");
    expect(row.declaredByUserId).toBe(organiser.id);
  });

  it("is idempotent — re-declaring updates the same row rather than creating a second", async () => {
    const { user: organiser, organizationId } = await newOrganizer();
    const event = await createTestEvent(organizationId);
    const operator = await createTestUser();
    await cashSale(operator.id, event); // system total = 200,000

    await saveFloatDeclarationCore({ eventId: event.id, operatorId: operator.id, declaredAmountCents: 100_000, declaredByUserId: organiser.id });
    const second = await saveFloatDeclarationCore({ eventId: event.id, operatorId: operator.id, declaredAmountCents: 200_000, declaredByUserId: organiser.id });

    expect(second.varianceCents).toBe(0);
    expect(second.status).toBe("BALANCED");
    const rows = await prisma.floatDeclaration.findMany({ where: { eventId: event.id, operatorId: operator.id } });
    expect(rows).toHaveLength(1);
    expect(rows[0].declaredAmountCents).toBe(200_000);
  });
});

describe("getReconciliationData", () => {
  it("summarises revenue by payment method, wallet balance, vendor sales and breakage", async () => {
    const { user: buyer, organizationId } = await newOrganizer();
    const event = await createTestEvent(organizationId);
    const operator = await createTestUser();

    await cashSale(operator.id, event); // OFFLINE_DEFERRED, 200,000
    // A digital (AIRPAY_ONLINE) sale — SIMULATED provider resolves it PAID.
    await handleSellTickets(buyer.id, {
      clientId: uid("digital-order"),
      eventId: event.id,
      items: [{ ticketTypeId: event.ticketTypes[0].id, quantity: 1, codes: [uid("code")] }],
      paymentMethod: "AIRPAY_ONLINE",
      phoneNumber: "0712345678",
    });

    const wallet = await createTestWallet(event.id, buyer.id, { balanceCents: 30_000 });
    const vendor = await createTestVendor(event.id);
    await handleChargeWallet(buyer.id, organizationId, {
      clientId: uid("charge"),
      walletCode: wallet.code,
      vendorId: vendor.id,
      eventId: event.id,
      amountCents: 12_000,
    });

    const data = await getReconciliationData(event.id);
    expect(data).not.toBeNull();
    expect(data!.summary.cashTicketRevenueCents).toBe(200_000);
    expect(data!.summary.digitalTicketRevenueCents).toBe(200_000);
    expect(data!.summary.totalTicketRevenueCents).toBe(400_000);
    // wallet started at 30,000, charged 12,000 → 18,000 unspent
    expect(data!.summary.unspentWalletBalanceCents).toBe(18_000);
    expect(data!.summary.vendorSalesCents).toBe(12_000);
    // wallet was just touched, so nothing is >90 days stale
    expect(data!.summary.netBreakageCents).toBe(0);
  });

  it("flags every cash operator with no FloatDeclaration as unreconciled, and clears them as they are declared", async () => {
    const { user: organiser, organizationId } = await newOrganizer();
    const event = await createTestEvent(organizationId);
    const opA = await createTestUser({ name: "Op A" });
    const opB = await createTestUser({ name: "Op B" });
    await cashSale(opA.id, event);
    await cashSale(opB.id, event);

    const before = await getReconciliationData(event.id);
    expect(before!.operators).toHaveLength(2);
    expect(before!.unreconciledOperatorCount).toBe(2);

    await saveFloatDeclarationCore({ eventId: event.id, operatorId: opA.id, declaredAmountCents: 200_000, declaredByUserId: organiser.id });

    const after = await getReconciliationData(event.id);
    expect(after!.unreconciledOperatorCount).toBe(1);
    expect(after!.operators.find((o) => o.operatorId === opA.id)!.declaration).not.toBeNull();
    expect(after!.operators.find((o) => o.operatorId === opB.id)!.declaration).toBeNull();
  });
});

describe("getOperatorFloat", () => {
  it("reflects only the requested operator's own cash orders, never another operator's on the same event", async () => {
    const { organizationId } = await newOrganizer();
    const event = await createTestEvent(organizationId, [{ priceCents: 200_000, quantityTotal: 20 }]);
    const opA = await createTestUser({ name: "Op A" });
    const opB = await createTestUser({ name: "Op B" });
    await cashSale(opA.id, event);
    await cashSale(opA.id, event);
    await cashSale(opB.id, event);

    const floatA = await getOperatorFloat(event.id, opA.id);
    expect(floatA!.cashTransactionCount).toBe(2);
    expect(floatA!.systemTotalCents).toBe(400_000);
    expect(floatA!.averageCents).toBe(200_000);

    const floatB = await getOperatorFloat(event.id, opB.id);
    expect(floatB!.cashTransactionCount).toBe(1);
    expect(floatB!.systemTotalCents).toBe(200_000);
  });
});

describe("buildReconciliationCsvSections", () => {
  it("returns a summary section and a per-operator section with one row per operator", async () => {
    const { organizationId } = await newOrganizer();
    const event = await createTestEvent(organizationId, [{ priceCents: 200_000, quantityTotal: 20 }]);
    const opA = await createTestUser({ name: "Op A" });
    const opB = await createTestUser({ name: "Op B" });
    await cashSale(opA.id, event);
    await cashSale(opB.id, event);

    const data = await getReconciliationData(event.id);
    const sections = buildReconciliationCsvSections(data!);

    expect(sections).toHaveLength(2);
    expect(sections[0].headers).toEqual(["Metric", "Amount (Major Units)", "Amount (Formatted)"]);
    expect(sections[0].rows).toHaveLength(6); // the 6 summary metrics
    expect(sections[1].headers).toEqual([
      "Operator",
      "Operator ID",
      "Cash transactions",
      "System total (Major Units)",
      "Average top-up (Major Units)",
      "Declared float (Major Units)",
      "Variance (Major Units)",
      "Status",
    ]);
    expect(sections[1].rows).toHaveLength(2); // one per operator
  });
});
