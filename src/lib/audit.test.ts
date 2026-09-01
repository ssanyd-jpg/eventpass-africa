import { describe, expect, it } from "vitest";
import { buildSyncAuditEntry } from "@/lib/audit";
import { formatCents } from "@/lib/format";

describe("buildSyncAuditEntry", () => {
  it("returns null when the operation didn't succeed", () => {
    expect(buildSyncAuditEntry("EDIT_EVENT", { ok: false, reason: "FORBIDDEN" })).toBeNull();
  });

  it("returns null for op types that aren't audited (personal/gate-scan ops)", () => {
    expect(buildSyncAuditEntry("CHECK_IN", { ok: true, ticket: {} })).toBeNull();
    expect(buildSyncAuditEntry("SELL_TICKETS", { ok: true, order: {} })).toBeNull();
    expect(buildSyncAuditEntry("CHARGE_WALLET", { ok: true, transaction: {} })).toBeNull();
  });

  it("builds an entry for CREATE_EVENT", () => {
    const entry = buildSyncAuditEntry("CREATE_EVENT", { ok: true, event: { title: "Bongo Beats Festival" } });
    expect(entry).toEqual({ action: "EVENT_CREATED", summary: 'Created "Bongo Beats Festival"' });
  });

  it("builds an entry for EDIT_EVENT", () => {
    const entry = buildSyncAuditEntry("EDIT_EVENT", { ok: true, event: { title: "Updated Title" } });
    expect(entry).toEqual({ action: "EVENT_EDITED", summary: 'Edited "Updated Title"' });
  });

  it("builds an entry for CANCEL_EVENT", () => {
    const entry = buildSyncAuditEntry("CANCEL_EVENT", { ok: true, event: { title: "Rained Out Fest" } });
    expect(entry).toEqual({ action: "EVENT_CANCELLED", summary: 'Cancelled "Rained Out Fest"' });
  });

  it("builds an entry for REFUND_ORDER", () => {
    const entry = buildSyncAuditEntry("REFUND_ORDER", { ok: true, order: { eventTitle: "Comedy Night" } });
    expect(entry).toEqual({ action: "ORDER_REFUNDED", summary: 'Refunded an order for "Comedy Night"' });
  });

  it("builds an entry for ADD_VENDOR", () => {
    const entry = buildSyncAuditEntry("ADD_VENDOR", { ok: true, vendor: { name: "Spice Grill" } });
    expect(entry).toEqual({ action: "VENDOR_ADDED", summary: 'Added vendor "Spice Grill"' });
  });

  it("builds an entry for APPROVE_VENDOR", () => {
    const entry = buildSyncAuditEntry("APPROVE_VENDOR", { ok: true, vendor: { name: "Spice Grill" } });
    expect(entry).toEqual({ action: "VENDOR_APPROVED", summary: 'Approved vendor "Spice Grill"' });
  });

  it("builds an entry for REJECT_VENDOR", () => {
    const entry = buildSyncAuditEntry("REJECT_VENDOR", { ok: true, vendor: { name: "Spice Grill" } });
    expect(entry).toEqual({ action: "VENDOR_REJECTED", summary: 'Rejected vendor "Spice Grill"' });
  });

  it("builds an entry for ADD_MOBILE_MONEY_ACCOUNT", () => {
    const entry = buildSyncAuditEntry("ADD_MOBILE_MONEY_ACCOUNT", { ok: true, account: { provider: "MPESA_TZ" } });
    expect(entry).toEqual({ action: "PAYOUT_ACCOUNT_ADDED", summary: "Linked a MPESA_TZ payout account" });
  });

  it("builds an entry for APPROVE_WITHDRAWAL", () => {
    const entry = buildSyncAuditEntry("APPROVE_WITHDRAWAL", { ok: true, transaction: { amountCents: 5000, currency: "TZS" } });
    expect(entry).toEqual({ action: "WITHDRAWAL_APPROVED", summary: `Approved a withdrawal of ${formatCents(5000, "TZS")}` });
  });

  it("builds an entry for REJECT_WITHDRAWAL", () => {
    const entry = buildSyncAuditEntry("REJECT_WITHDRAWAL", { ok: true, transaction: { amountCents: 5000, currency: "TZS" } });
    expect(entry).toEqual({ action: "WITHDRAWAL_REJECTED", summary: `Rejected a withdrawal of ${formatCents(5000, "TZS")}` });
  });

  it("returns null for WITHDRAW_WALLET (buyer self-action, not audited)", () => {
    expect(buildSyncAuditEntry("WITHDRAW_WALLET", { ok: true, transaction: {} })).toBeNull();
  });
});
