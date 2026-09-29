import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { prisma } from "@/lib/prisma";
import { createTestUser, createTestOrganization, addMembership } from "@/lib/test-fixtures";
import { createSeasonPass, publishSeasonPass, purchaseSeasonPass } from "@/lib/season-pass";
import {
  getSeasonPassesEligibleForRenewal,
  sendRenewalOffer,
  processRenewal,
  declineRenewal,
  getRenewalOfferStatus,
} from "@/lib/season-renewal";

// Season pass auto-renewal — layered on the foundation tested in
// season-pass.test.ts. Same AIRPAY_*-clearing trick (see that file's own
// comment) so processRenewal's initiateCharge call hits the deterministic
// PAID-always simulator instead of the real (403-ing) Airpay API.
const AIRPAY_VARS = [
  "AIRPAY_MERCHANT_ID",
  "AIRPAY_CLIENT_ID",
  "AIRPAY_CLIENT_SECRET",
  "AIRPAY_USERNAME",
  "AIRPAY_PASSWORD",
  "AIRPAY_SECRET",
  "AIRPAY_MERCHANT_DOMAIN",
] as const;
const originalAirpayValues = Object.fromEntries(AIRPAY_VARS.map((k) => [k, process.env[k]]));

beforeEach(() => {
  for (const k of AIRPAY_VARS) delete process.env[k];
});

afterEach(async () => {
  for (const k of AIRPAY_VARS) {
    const original = originalAirpayValues[k];
    if (original === undefined) delete process.env[k];
    else process.env[k] = original;
  }
  await new Promise((resolve) => setTimeout(resolve, 500));
});

let seq = 0;

async function newOrganizer() {
  const user = await createTestUser();
  const organization = await createTestOrganization();
  await addMembership(organization.id, user.id, "OWNER");
  return { user, organizationId: organization.id };
}

const DAY_MS = 24 * 60 * 60 * 1000;

// A published, auto-renew-enabled pass expiring `endInDays` from now, with
// one purchased ACTIVE holder.
async function passWithHolder(organizationId: string, endInDays: number, autoRenewEnabled = true) {
  const created = await createSeasonPass(organizationId, {
    name: "Simba SC 2026/27 Season",
    price: 5_000_00,
    autoRenewPrice: 5_500_00,
    autoRenewEnabled,
    startDate: new Date(Date.now() - 300 * DAY_MS),
    endDate: new Date(Date.now() + endInDays * DAY_MS),
  });
  if (!created.ok) throw new Error(created.error);
  await publishSeasonPass(organizationId, created.seasonPassId);

  const buyer = await createTestUser({ name: "Amina Juma" });
  const purchase = await purchaseSeasonPass(created.seasonPassId, { userId: buyer.id, name: buyer.name, phone: `07${String(Date.now() % 100_000_000).padStart(8, "0")}${++seq}` });
  if (!purchase.ok || purchase.status !== "CONFIRMED") throw new Error("expected a confirmed purchase");

  const holder = await prisma.seasonPassHolder.findUniqueOrThrow({ where: { id: purchase.holderId } });
  return { seasonPassId: created.seasonPassId, holder };
}

describe("getSeasonPassesEligibleForRenewal", () => {
  it("includes an autoRenewEnabled pass expiring within 30 days with an ACTIVE holder", async () => {
    const { organizationId } = await newOrganizer();
    const { holder } = await passWithHolder(organizationId, 15);

    const eligible = await getSeasonPassesEligibleForRenewal();
    expect(eligible.some((e) => e.holderId === holder.id)).toBe(true);
  });

  it("excludes a pass expiring more than 30 days out", async () => {
    const { organizationId } = await newOrganizer();
    const { holder } = await passWithHolder(organizationId, 60);

    const eligible = await getSeasonPassesEligibleForRenewal();
    expect(eligible.some((e) => e.holderId === holder.id)).toBe(false);
  });

  it("excludes a pass that already expired", async () => {
    const { organizationId } = await newOrganizer();
    const { holder } = await passWithHolder(organizationId, -2);

    const eligible = await getSeasonPassesEligibleForRenewal();
    expect(eligible.some((e) => e.holderId === holder.id)).toBe(false);
  });

  it("excludes a pass with auto-renew disabled", async () => {
    const { organizationId } = await newOrganizer();
    const { holder } = await passWithHolder(organizationId, 15, false);

    const eligible = await getSeasonPassesEligibleForRenewal();
    expect(eligible.some((e) => e.holderId === holder.id)).toBe(false);
  });

  it("excludes a holder who's already been offered a renewal", async () => {
    const { organizationId } = await newOrganizer();
    const { holder } = await passWithHolder(organizationId, 15);
    await sendRenewalOffer(holder.id);

    const eligible = await getSeasonPassesEligibleForRenewal();
    expect(eligible.some((e) => e.holderId === holder.id)).toBe(false);
  });
});

describe("sendRenewalOffer", () => {
  it("sends a WhatsApp offer, sets RENEWAL_OFFERED, and generates a token", async () => {
    const { organizationId } = await newOrganizer();
    const { holder } = await passWithHolder(organizationId, 15);

    const result = await sendRenewalOffer(holder.id);
    expect(result.ok).toBe(true);
    if (!result.ok || "skipped" in result) throw new Error("expected a sent offer");

    const updated = await prisma.seasonPassHolder.findUniqueOrThrow({ where: { id: holder.id } });
    expect(updated.renewalStatus).toBe("RENEWAL_OFFERED");
    expect(updated.renewalOfferedAt).not.toBeNull();
    expect(updated.renewalToken).toBe(result.renewalToken);

    const log = await prisma.notificationLog.findFirstOrThrow({ where: { type: "SEASON_PASS_RENEWAL_OFFERED", recipient: holder.phone } });
    expect(log.body).toContain(`chaap.africa/renew/${result.renewalToken}`);
    // "Club Name" in the template is the organisation's name, not the
    // SeasonPass row's own `name` field — same as purchaseSeasonPass's
    // confirmation message (see season-pass.test.ts's own comment on this).
    expect(log.body).toContain("Test Org");
  });

  it("skips a duplicate offer for the same holder, via NotificationLog", async () => {
    const { organizationId } = await newOrganizer();
    const { holder } = await passWithHolder(organizationId, 15);

    const first = await sendRenewalOffer(holder.id);
    expect(first.ok).toBe(true);

    // Reset renewalStatus back to ACTIVE to simulate a second sweep run
    // hitting the same holder before the NotificationLog check would catch
    // it any other way — the dedup must hold even then.
    await prisma.seasonPassHolder.update({ where: { id: holder.id }, data: { renewalStatus: "ACTIVE" } });

    const second = await sendRenewalOffer(holder.id);
    expect(second.ok).toBe(true);
    expect("skipped" in second && second.skipped).toBe(true);

    const count = await prisma.notificationLog.count({ where: { type: "SEASON_PASS_RENEWAL_OFFERED", recipient: holder.phone } });
    expect(count).toBe(1);
  });
});

describe("processRenewal", () => {
  it("validates a fresh token, charges, confirms, and extends endDate by 12 months", async () => {
    const { organizationId } = await newOrganizer();
    const { seasonPassId, holder } = await passWithHolder(organizationId, 15);
    const offer = await sendRenewalOffer(holder.id);
    if (!offer.ok || "skipped" in offer) throw new Error("expected a sent offer");

    const before = await prisma.seasonPass.findUniqueOrThrow({ where: { id: seasonPassId } });

    const result = await processRenewal(offer.renewalToken, { phoneNumber: "0712345678" });
    expect(result).toEqual({ ok: true, status: "CONFIRMED" });

    const updatedHolder = await prisma.seasonPassHolder.findUniqueOrThrow({ where: { id: holder.id } });
    expect(updatedHolder.renewalStatus).toBe("RENEWAL_CONFIRMED");
    expect(updatedHolder.renewalConfirmedAt).not.toBeNull();

    const after = await prisma.seasonPass.findUniqueOrThrow({ where: { id: seasonPassId } });
    const expectedEndDate = new Date(before.endDate);
    expectedEndDate.setMonth(expectedEndDate.getMonth() + 12);
    expect(after.endDate.getTime()).toBe(expectedEndDate.getTime());

    const log = await prisma.notificationLog.findFirstOrThrow({ where: { type: "SEASON_PASS_RENEWED", recipient: holder.phone } });
    expect(log.body).toContain("renewed");
  });

  it("rejects a token used more than 7 days after the offer", async () => {
    const { organizationId } = await newOrganizer();
    const { holder } = await passWithHolder(organizationId, 15);
    const offer = await sendRenewalOffer(holder.id);
    if (!offer.ok || "skipped" in offer) throw new Error("expected a sent offer");

    const eightDaysLater = new Date(Date.now() + 8 * DAY_MS);
    const result = await processRenewal(offer.renewalToken, { phoneNumber: "0712345678" }, eightDaysLater);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatch(/expired/i);

    const updatedHolder = await prisma.seasonPassHolder.findUniqueOrThrow({ where: { id: holder.id } });
    expect(updatedHolder.renewalStatus).toBe("RENEWAL_OFFERED");
  });

  it("handles an already-renewed token gracefully", async () => {
    const { organizationId } = await newOrganizer();
    const { holder } = await passWithHolder(organizationId, 15);
    const offer = await sendRenewalOffer(holder.id);
    if (!offer.ok || "skipped" in offer) throw new Error("expected a sent offer");

    const first = await processRenewal(offer.renewalToken, { phoneNumber: "0712345678" });
    expect(first.ok).toBe(true);

    const second = await processRenewal(offer.renewalToken, { phoneNumber: "0712345678" });
    expect(second.ok).toBe(false);
    if (second.ok) return;
    expect(second.error).toMatch(/already renewed/i);
  });

  it("rejects an unknown token", async () => {
    const result = await processRenewal("not-a-real-token", { phoneNumber: "0712345678" });
    expect(result.ok).toBe(false);
  });
});

describe("declineRenewal", () => {
  it("sets RENEWAL_DECLINED and sends an acknowledgement", async () => {
    const { organizationId } = await newOrganizer();
    const { holder } = await passWithHolder(organizationId, 15);
    const offer = await sendRenewalOffer(holder.id);
    if (!offer.ok || "skipped" in offer) throw new Error("expected a sent offer");

    const result = await declineRenewal(offer.renewalToken);
    expect(result.ok).toBe(true);

    const updated = await prisma.seasonPassHolder.findUniqueOrThrow({ where: { id: holder.id } });
    expect(updated.renewalStatus).toBe("RENEWAL_DECLINED");

    const log = await prisma.notificationLog.findFirstOrThrow({ where: { type: "SEASON_PASS_RENEWAL_DECLINED", recipient: holder.phone } });
    expect(log.body.toLowerCase()).toContain("expires");
  });
});

describe("getRenewalOfferStatus", () => {
  it("reports ALREADY_RENEWED for a confirmed holder's token", async () => {
    const { organizationId } = await newOrganizer();
    const { holder } = await passWithHolder(organizationId, 15);
    const offer = await sendRenewalOffer(holder.id);
    if (!offer.ok || "skipped" in offer) throw new Error("expected a sent offer");
    await processRenewal(offer.renewalToken, { phoneNumber: "0712345678" });

    const status = await getRenewalOfferStatus(offer.renewalToken);
    expect(status?.state).toBe("ALREADY_RENEWED");
  });

  it("returns null for an unknown token", async () => {
    expect(await getRenewalOfferStatus("not-a-real-token")).toBeNull();
  });
});
