import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { prisma } from "@/lib/prisma";
import { createTestEvent, createTestOrganization, createTestUser, createTestWallet } from "@/lib/test-fixtures";

// Same provider-mocking discipline as wallet-handlers.test.ts: with no real
// Airpay credentials the active provider is the simulator (instant PAID), so
// the PENDING/FAILED branches a real provider returns can only be reached by
// mocking getActivePaymentProvider. vi.hoisted for the reason spelled out in
// whatsapp.test.ts.
const { mockInitiateCharge } = vi.hoisted(() => ({ mockInitiateCharge: vi.fn() }));
vi.mock("@/lib/payments", () => ({
  getActivePaymentProvider: () => ({
    name: "MOCK",
    isConfigured: () => true,
    initiateCharge: mockInitiateCharge,
  }),
}));

import { handleUssd, verifyUssdSecret, MIN_TOPUP_TZS, MAX_TOPUP_TZS } from "@/lib/ussd";

beforeEach(() => {
  mockInitiateCharge.mockReset();
  mockInitiateCharge.mockResolvedValue({ status: "PENDING", reference: "MOCK-PENDING-REF" });
});

let counter = 0;
function uniquePhone() {
  counter += 1;
  // 255 + 9 digits, unique per call so leftover rows from earlier runs can
  // never match the phone a test is asserting against.
  const tail = `${Date.now()}${counter}`.slice(-8);
  return `+2557${tail}`;
}
function uniqueSession() {
  counter += 1;
  return `ATUid_test_${Date.now()}_${counter}`;
}

function call(phoneNumber: string, text: string, sessionId = uniqueSession()) {
  return handleUssd({ sessionId, serviceCode: "*384*123#", phoneNumber, text });
}

// One attendee with a wallet on a LIVE event, phone stored the way
// handleSellTickets stores it (normalized E.164).
async function attendeeWithWallet(balanceCents = 0, currency = "TZS") {
  const phone = uniquePhone();
  const organization = await createTestOrganization();
  const attendee = await createTestUser();
  await prisma.user.update({ where: { id: attendee.id }, data: { phone } });
  const event = await createTestEvent(organization.id, undefined, currency);
  const wallet = await createTestWallet(event.id, attendee.id, { balanceCents, currency });
  return { phone, attendee, event, wallet };
}

describe("main menu", () => {
  it("returns the CON welcome menu when text is empty", async () => {
    const response = await call(uniquePhone(), "");
    expect(response).toBe("CON Welcome to Chaap\n1. Check balance\n2. Top up wallet\n3. View last transaction");
  });

  it("rejects an unknown menu choice with END", async () => {
    expect(await call(uniquePhone(), "9")).toBe("END Invalid choice");
    // Option 1 takes no further input.
    expect(await call(uniquePhone(), "1*5")).toBe("END Invalid choice");
  });

  it("rejects a request with no session id or phone number", async () => {
    expect(await handleUssd({ sessionId: "", serviceCode: "*384#", phoneNumber: uniquePhone(), text: "" })).toBe("END Invalid request");
    expect(await handleUssd({ sessionId: "s", serviceCode: "*384#", phoneNumber: "", text: "" })).toBe("END Invalid request");
  });
});

describe("check balance (text = 1)", () => {
  it("shows the balance for a known number, converting cents to whole shillings", async () => {
    const { phone } = await attendeeWithWallet(1_250_000);
    expect(await call(phone, "1")).toBe("END Your Chaap balance is TZS 12,500");
  });

  it("finds the wallet however the caller's number is formatted", async () => {
    const { phone } = await attendeeWithWallet(500_000);
    // Local form of the same number — normalizeTanzaniaPhone maps it to E.164.
    const local = `0${phone.slice(4)}`;
    expect(await call(local, "1")).toBe("END Your Chaap balance is TZS 5,000");
  });

  it("says no wallet was found for an unknown number", async () => {
    expect(await call(uniquePhone(), "1")).toBe("END No Chaap wallet found for this number");
  });

  it("ignores wallets that aren't in TZS", async () => {
    const { phone } = await attendeeWithWallet(1_000_000, "USD");
    expect(await call(phone, "1")).toBe("END No Chaap wallet found for this number");
  });

  it("prefers the wallet on a LIVE event over a more recently touched one on a finished event", async () => {
    const { phone, attendee } = await attendeeWithWallet(300_000);
    const organization = await createTestOrganization();
    const oldEvent = await createTestEvent(organization.id);
    await prisma.event.update({ where: { id: oldEvent.id }, data: { status: "ENDED" } });
    // Touched after the live one, so plain "most recently updated" would pick it.
    await createTestWallet(oldEvent.id, attendee.id, { balanceCents: 900_000 });

    expect(await call(phone, "1")).toBe("END Your Chaap balance is TZS 3,000");
  });
});

describe("top up (text = 2)", () => {
  it("prompts for an amount with CON", async () => {
    expect(await call(uniquePhone(), "2")).toBe("CON Enter top-up amount (TZS):");
  });

  it("accepts the minimum amount and starts an Airpay charge in cents", async () => {
    const { phone, wallet } = await attendeeWithWallet(0);
    const response = await call(phone, `2*${MIN_TOPUP_TZS}`);

    expect(response).toBe("END Processing your top-up of TZS 2,000. You will receive an M-Pesa prompt shortly.");
    expect(mockInitiateCharge).toHaveBeenCalledTimes(1);
    expect(mockInitiateCharge).toHaveBeenCalledWith(
      expect.objectContaining({ amountCents: 200_000, phoneNumber: phone })
    );

    // PENDING: recorded against the wallet, balance untouched until the
    // charge is confirmed.
    const tx = await prisma.walletTransaction.findFirstOrThrow({ where: { walletId: wallet.id } });
    expect(tx).toMatchObject({ type: "TOPUP", status: "PENDING", amountCents: 200_000, phoneNumber: phone });
    expect((await prisma.wallet.findUniqueOrThrow({ where: { id: wallet.id } })).balanceCents).toBe(0);
  });

  it("accepts the maximum amount", async () => {
    const { phone } = await attendeeWithWallet(0);
    const response = await call(phone, `2*${MAX_TOPUP_TZS}`);

    expect(response).toBe("END Processing your top-up of TZS 500,000. You will receive an M-Pesa prompt shortly.");
    expect(mockInitiateCharge).toHaveBeenCalledWith(expect.objectContaining({ amountCents: 50_000_000 }));
  });

  it.each([
    ["one shilling under the minimum", String(MIN_TOPUP_TZS - 1)],
    ["one shilling over the maximum", String(MAX_TOPUP_TZS + 1)],
    ["zero", "0"],
    ["text", "abc"],
    ["a decimal", "5000.50"],
    ["a negative", "-5000"],
    ["a thousands separator", "5,000"],
    ["nothing at all", ""],
    ["an absurdly long number", "9".repeat(30)],
  ])("re-prompts with CON and charges nothing for %s", async (_label, entry) => {
    const response = await call(uniquePhone(), `2*${entry}`);

    expect(response).toBe("CON Invalid amount. Enter an amount from 2,000 to 500,000 (TZS):");
    expect(mockInitiateCharge).not.toHaveBeenCalled();
  });

  it("uses the latest entry when an earlier one was invalid", async () => {
    const { phone } = await attendeeWithWallet(0);
    const response = await call(phone, "2*abc*5000");

    expect(response).toBe("END Processing your top-up of TZS 5,000. You will receive an M-Pesa prompt shortly.");
    expect(mockInitiateCharge).toHaveBeenCalledTimes(1);
  });

  it("says no wallet was found, and charges nothing, for an unknown number", async () => {
    expect(await call(uniquePhone(), "2*5000")).toBe("END No Chaap wallet found for this number");
    expect(mockInitiateCharge).not.toHaveBeenCalled();
  });

  it("refuses a top-up when the wallet's event isn't LIVE", async () => {
    const { phone, event } = await attendeeWithWallet(0);
    await prisma.event.update({ where: { id: event.id }, data: { status: "ENDED" } });

    expect(await call(phone, "2*5000")).toBe("END Top-ups are not available for your event right now");
    expect(mockInitiateCharge).not.toHaveBeenCalled();
  });

  it("credits the wallet straight away when the provider confirms instantly", async () => {
    mockInitiateCharge.mockResolvedValue({ status: "PAID", reference: "MOCK-PAID-REF" });
    const { phone, wallet } = await attendeeWithWallet(100_000);

    expect(await call(phone, "2*5000")).toBe("END Your top-up of TZS 5,000 is complete. New balance: TZS 6,000");
    expect((await prisma.wallet.findUniqueOrThrow({ where: { id: wallet.id } })).balanceCents).toBe(600_000);
  });

  it("tells the caller when the charge couldn't be started", async () => {
    mockInitiateCharge.mockResolvedValue({ status: "FAILED", reference: "MOCK-FAILED-REF" });
    const { phone, wallet } = await attendeeWithWallet(0);

    expect(await call(phone, "2*5000")).toBe("END Your top-up of TZS 5,000 could not be started. Please try again");
    expect((await prisma.wallet.findUniqueOrThrow({ where: { id: wallet.id } })).balanceCents).toBe(0);
  });

  it("doesn't raise a second charge if the same session's final input is delivered twice", async () => {
    const { phone, wallet } = await attendeeWithWallet(0);
    const sessionId = uniqueSession();

    const first = await call(phone, "2*5000", sessionId);
    const second = await call(phone, "2*5000", sessionId);

    expect(second).toBe(first);
    expect(mockInitiateCharge).toHaveBeenCalledTimes(1);
    expect(await prisma.walletTransaction.count({ where: { walletId: wallet.id } })).toBe(1);
  });
});

describe("view last transaction (text = 3)", () => {
  it("formats the most recent transaction as type, amount and date", async () => {
    const { phone, wallet } = await attendeeWithWallet(0);
    await prisma.walletTransaction.create({
      data: { walletId: wallet.id, type: "SALE", amountCents: 150_000, createdAt: new Date("2026-03-04T09:00:00Z") },
    });
    await prisma.walletTransaction.create({
      data: { walletId: wallet.id, type: "TOPUP", amountCents: 500_000, createdAt: new Date("2026-03-05T10:00:00Z") },
    });

    expect(await call(phone, "3")).toBe("END Last transaction: Top-up TZS 5,000 on 5 Mar 2026");
  });

  it("uses the Tanzanian calendar day, not the server's UTC one", async () => {
    const { phone, wallet } = await attendeeWithWallet(0);
    // 22:30 UTC is 01:30 the next day in Dar es Salaam (UTC+3).
    await prisma.walletTransaction.create({
      data: { walletId: wallet.id, type: "SALE", amountCents: 250_000, createdAt: new Date("2026-03-05T22:30:00Z") },
    });

    expect(await call(phone, "3")).toBe("END Last transaction: Purchase TZS 2,500 on 6 Mar 2026");
  });

  it("flags a transaction that hasn't completed, and copes with one that has no amount", async () => {
    const { phone, wallet } = await attendeeWithWallet(0);
    await prisma.walletTransaction.create({
      data: { walletId: wallet.id, type: "TOPUP", status: "PENDING", amountCents: 500_000, createdAt: new Date("2026-03-05T10:00:00Z") },
    });
    expect(await call(phone, "3")).toBe("END Last transaction: Top-up TZS 5,000 (pending) on 5 Mar 2026");

    await prisma.walletTransaction.create({
      data: { walletId: wallet.id, type: "SPONSOR_TAP", amountCents: null, createdAt: new Date("2026-03-06T10:00:00Z") },
    });
    expect(await call(phone, "3")).toBe("END Last transaction: Sponsor tap on 6 Mar 2026");
  });

  it("says no transactions were found for a wallet with none", async () => {
    const { phone } = await attendeeWithWallet(0);
    expect(await call(phone, "3")).toBe("END No transactions found");
  });

  it("says no transactions were found for an unknown number", async () => {
    expect(await call(uniquePhone(), "3")).toBe("END No transactions found");
  });
});

describe("verifyUssdSecret", () => {
  const originalSecret = process.env.AT_USSD_SECRET;

  afterEach(() => {
    if (originalSecret === undefined) delete process.env.AT_USSD_SECRET;
    else process.env.AT_USSD_SECRET = originalSecret;
  });

  it("accepts the configured secret", () => {
    process.env.AT_USSD_SECRET = "test-ussd-secret";
    expect(verifyUssdSecret("test-ussd-secret")).toBe(true);
  });

  it("rejects a wrong secret, including one of a different length", () => {
    process.env.AT_USSD_SECRET = "test-ussd-secret";
    expect(verifyUssdSecret("wrong-secret-xx")).toBe(false);
    expect(verifyUssdSecret("short")).toBe(false);
    expect(verifyUssdSecret("test-ussd-secret-and-more")).toBe(false);
  });

  it("rejects a missing header", () => {
    process.env.AT_USSD_SECRET = "test-ussd-secret";
    expect(verifyUssdSecret(null)).toBe(false);
    expect(verifyUssdSecret("")).toBe(false);
  });

  it("rejects everything when AT_USSD_SECRET isn't configured", () => {
    delete process.env.AT_USSD_SECRET;
    expect(verifyUssdSecret("undefined")).toBe(false);
    expect(verifyUssdSecret("")).toBe(false);
    expect(verifyUssdSecret(null)).toBe(false);
  });
});
