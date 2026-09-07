"use client";

import { useEffect, useState, useSyncExternalStore } from "react";
import {
  db,
  newLocalId,
  getOrCreateDeviceId,
  type LocalEvent,
  type LocalOrder,
  type LocalVendor,
  type LocalSponsor,
  type LocalWallet,
  type LocalWalletTransaction,
  type LocalDiscountCode,
  type LocalSurveyQuestion,
  type LocalPendingSurvey,
  type LocalSponsorCampaign,
  type LocalCredential,
  type OutboxOpType,
} from "@/lib/db";

// ---------- online status ----------

function subscribeOnline(callback: () => void) {
  window.addEventListener("online", callback);
  window.addEventListener("offline", callback);
  return () => {
    window.removeEventListener("online", callback);
    window.removeEventListener("offline", callback);
  };
}

export function useOnlineStatus(): boolean {
  return useSyncExternalStore(
    subscribeOnline,
    () => navigator.onLine,
    () => true
  );
}

// ---------- pending outbox count (live) ----------

export function usePendingCount(): number {
  const [count, setCount] = useState(0);
  useEffect(() => {
    if (!db) return;
    let cancelled = false;
    const refresh = async () => {
      const n = await db.outbox.where("status").anyOf("pending", "failed").count();
      if (!cancelled) setCount(n);
    };
    refresh();
    const id = setInterval(refresh, 2000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, []);
  return count;
}

// ---------- queueing local mutations ----------

export async function queueOp(type: OutboxOpType, payload: Record<string, unknown>) {
  await db.outbox.add({
    type,
    payload,
    createdAt: new Date().toISOString(),
    status: "pending",
    attempts: 0,
  });
  scheduleFlush();
}

// ---------- pull (catalog + user scoped data) ----------

export async function pullFromServer(): Promise<{ ok: boolean }> {
  if (!db || !navigator.onLine) return { ok: false };
  try {
    const deviceId = await getOrCreateDeviceId();
    const res = await fetch("/api/sync/pull", {
      cache: "no-store",
      headers: deviceId ? { "X-Device-Id": deviceId } : undefined,
    });
    if (!res.ok) return { ok: false };
    const data = await res.json();

    if (Array.isArray(data.events)) {
      await db.events.bulkPut(
        data.events.map(
          (e: LocalEvent): LocalEvent => ({ ...e, syncStatus: "synced" })
        )
      );
    }

    if (Array.isArray(data.myOrders)) {
      for (const order of data.myOrders as LocalOrder[]) {
        const existing = await db.orders
          .where("clientId")
          .equals(order.clientId ?? "")
          .first();
        if (existing && existing.id !== order.id) {
          await db.orders.delete(existing.id);
        }
        await db.orders.put({ ...order, syncStatus: "synced" });
      }
    }

    if (Array.isArray(data.mobileMoneyAccounts)) {
      await db.mobileMoneyAccounts.bulkPut(
        data.mobileMoneyAccounts.map((a: Record<string, unknown>) => ({
          ...a,
          syncStatus: "synced" as const,
        }))
      );
    }

    if (Array.isArray(data.settlements)) {
      await db.settlements.bulkPut(data.settlements);
    }

    if (Array.isArray(data.myVendors)) {
      for (const vendor of data.myVendors as LocalVendor[]) {
        const existing = await db.vendors
          .where("clientId")
          .equals(vendor.clientId ?? "")
          .first();
        if (existing && existing.id !== vendor.id) {
          await db.vendors.delete(existing.id);
        }
        await db.vendors.put({ ...vendor, syncStatus: "synced" });
      }
    }

    if (Array.isArray(data.mySponsors)) {
      for (const sponsor of data.mySponsors as LocalSponsor[]) {
        const existing = await db.sponsors
          .where("clientId")
          .equals(sponsor.clientId ?? "")
          .first();
        if (existing && existing.id !== sponsor.id) {
          await db.sponsors.delete(existing.id);
        }
        await db.sponsors.put({ ...sponsor, syncStatus: "synced" });
      }
    }

    if (Array.isArray(data.myCampaigns)) {
      await db.sponsorCampaigns.bulkPut(data.myCampaigns as LocalSponsorCampaign[]);
    }

    if (Array.isArray(data.myDiscountCodes)) {
      await db.discountCodes.bulkPut(data.myDiscountCodes as LocalDiscountCode[]);
    }

    if (Array.isArray(data.mySurveyQuestions)) {
      await db.surveyQuestions.bulkPut(data.mySurveyQuestions as LocalSurveyQuestion[]);
    }

    // Full-replace, not bulkPut-only — this list must shrink as the buyer
    // responds (a responded-to survey stops being "pending" server-side and
    // must disappear locally too), unlike every other table here.
    if (Array.isArray(data.pendingSurveys)) {
      await db.pendingSurveys.clear();
      await db.pendingSurveys.bulkPut(data.pendingSurveys as LocalPendingSurvey[]);
    }

    // Full-replace, same reasoning as pendingSurveys — this pointer list
    // must change (grow, shrink, or reorder) as purchase history and live
    // events change, not just accumulate.
    if (Array.isArray(data.recommendedEventIds)) {
      await db.recommendedEvents.clear();
      await db.recommendedEvents.bulkPut((data.recommendedEventIds as string[]).map((id) => ({ id })));
    }

    // Full-replace, same reasoning as pendingSurveys/recommendedEvents — a
    // SUPERSEDED transition (a tag reassigned to someone else) must promptly
    // stop the old row from resolving on every device, and Credential has no
    // clientId/updatedAt to key an incremental merge on.
    if (Array.isArray(data.credentials)) {
      await db.credentials.clear();
      await db.credentials.bulkPut(data.credentials as LocalCredential[]);
    }

    if (Array.isArray(data.myWallets)) {
      await db.wallets.bulkPut(
        data.myWallets.map((w: LocalWallet): LocalWallet => ({ ...w, syncStatus: "synced" }))
      );
    }

    if (Array.isArray(data.myWalletTransactions)) {
      for (const t of data.myWalletTransactions as LocalWalletTransaction[]) {
        const existing = await db.walletTransactions
          .where("clientId")
          .equals(t.clientId ?? "")
          .first();
        if (existing && existing.id !== t.id) {
          await db.walletTransactions.delete(existing.id);
        }
        await db.walletTransactions.put({ ...t, syncStatus: "synced" });
      }
    }

    await db.meta.put({ key: "lastSyncedAt", value: new Date().toISOString() });
    return { ok: true };
  } catch {
    return { ok: false };
  }
}

// ---------- push (flush outbox sequentially) ----------

async function applyCreateEventResult(payload: any, result: any) {
  const localId = payload.eventId as string;
  const server = result.event;
  if (localId !== server.id) {
    await db.events.delete(localId);
    // remap any local orders pointing at the temp id
    const affected = await db.orders.where("eventId").equals(localId).toArray();
    for (const o of affected) {
      await db.orders.put({ ...o, eventId: server.id, eventClientId: server.clientId });
    }
  }
  await db.events.put({ ...server, syncStatus: "synced" });
}

async function applyEditOrCancelEventResult(payload: any, result: any) {
  const localId = payload.eventId as string;
  const server = result.event;
  if (localId !== server.id) {
    const existing = await db.events.get(localId);
    await db.events.delete(localId);
    if (existing) {
      const affected = await db.orders.where("eventId").equals(localId).toArray();
      for (const o of affected) {
        await db.orders.put({ ...o, eventId: server.id, eventClientId: server.clientId });
      }
    }
  }
  await db.events.put({ ...server, syncStatus: "synced" });
}

async function applyRefundOrderResult(payload: any, result: any) {
  const localId = payload.orderId as string;
  const server = result.order;
  if (localId !== server.id) {
    await db.orders.delete(localId);
  }
  await db.orders.put({ ...server, syncStatus: "synced" });

  if (Array.isArray(result.ticketTypeUpdates) && result.ticketTypeUpdates.length > 0) {
    const event = await db.events.get(server.eventId);
    if (event) {
      const updated = {
        ...event,
        ticketTypes: event.ticketTypes.map((tt) => {
          const match = result.ticketTypeUpdates.find((u: any) => u.id === tt.id);
          return match ? { ...tt, quantitySold: match.quantitySold } : tt;
        }),
      };
      await db.events.put(updated);
    }
  }
}

async function applySellTicketsResult(payload: any, result: any) {
  const localId = payload.clientId as string;
  const server = result.order;
  const paymentFailed = server.status === "PAYMENT_FAILED";
  await db.orders.delete(localId);
  await db.orders.put({
    ...server,
    syncStatus: result.oversold || paymentFailed ? "conflict" : "synced",
    syncError: result.oversold
      ? "Some items exceeded remaining capacity — organizer review needed."
      : paymentFailed
        ? "Payment failed — no tickets were issued."
        : null,
  });

  if (Array.isArray(result.ticketTypeUpdates)) {
    const event = await db.events.get(server.eventId);
    if (event) {
      const updated = {
        ...event,
        ticketTypes: event.ticketTypes.map((tt) => {
          const match = result.ticketTypeUpdates.find((u: any) => u.id === tt.id);
          return match ? { ...tt, quantitySold: match.quantitySold } : tt;
        }),
      };
      await db.events.put(updated);
    }
  }
}

// Mirrors applyRefundOrderResult — acts on an already-synced order id (no
// local-temp-id remap needed), and patches the cached event's
// ticketTypes[].quantitySold when the FAILED branch released inventory.
async function applyCheckOrderPaymentStatusResult(_payload: any, result: any) {
  await db.orders.put({ ...result.order, syncStatus: "synced" });

  if (Array.isArray(result.ticketTypeUpdates) && result.ticketTypeUpdates.length > 0) {
    const event = await db.events.get(result.order.eventId);
    if (event) {
      const updated = {
        ...event,
        ticketTypes: event.ticketTypes.map((tt) => {
          const match = result.ticketTypeUpdates.find((u: any) => u.id === tt.id);
          return match ? { ...tt, quantitySold: match.quantitySold } : tt;
        }),
      };
      await db.events.put(updated);
    }
  }
}

async function applyCheckInResult(_payload: any, result: any) {
  if (!result.ticket) return;
  const ticket = result.ticket;
  const order = await db.orders.get(ticket.orderId);
  if (!order) return;
  const updated = {
    ...order,
    tickets: order.tickets.map((t) =>
      t.code === ticket.code
        ? { ...t, checkedIn: true, checkedInAt: ticket.checkedInAt }
        : t
    ),
  };
  await db.orders.put(updated);
}

async function applyMobileMoneyResult(payload: any, result: any) {
  const localId = payload.clientId as string;
  await db.mobileMoneyAccounts.delete(localId);
  await db.mobileMoneyAccounts.put({ ...result.account, syncStatus: "synced" });
}

// Shared by APPLY_VENDOR and ADD_VENDOR — both create a vendor from a
// client-generated id, same delete-local-then-put-server shape.
async function applyCreateVendorResult(payload: any, result: any) {
  const localId = payload.clientId as string;
  await db.vendors.delete(localId);
  await db.vendors.put({ ...result.vendor, syncStatus: "synced" });
}

// Shared by APPROVE_VENDOR and REJECT_VENDOR — both act on an
// already-synced vendor id (never a local temp id), so no remap needed.
async function applyVendorStatusResult(_payload: any, result: any) {
  await db.vendors.put({ ...result.vendor, syncStatus: "synced" });
}

async function applyCheckInVendorResult(_payload: any, result: any) {
  if (!result.vendor) return;
  await db.vendors.put({ ...result.vendor, syncStatus: "synced" });
}

// Same delete-local-then-put-server shape as applyCreateVendorResult.
async function applyCreateSponsorResult(payload: any, result: any) {
  const localId = payload.clientId as string;
  await db.sponsors.delete(localId);
  await db.sponsors.put({ ...result.sponsor, syncStatus: "synced" });
}

async function applyCreateWalletResult(payload: any, result: any) {
  const localId = payload.clientId as string;
  await db.wallets.delete(localId);
  await db.wallets.put({ ...result.wallet, syncStatus: "synced" });
}

// Replaces the two optimistic LocalCredential rows written under the
// clientId-derived keys (see the provisioning page) with the
// server-authoritative rows, and reconciles the wallet the same way
// applyCreateWalletResult does (a new attendee's wallet was also written
// optimistically alongside the credentials).
async function applyProvisionCredentialResult(payload: any, result: any) {
  await db.credentials.delete(`${payload.clientId}-wallet`);
  await db.credentials.delete(`${payload.clientId}-ticket`);
  for (const c of result.credentials ?? []) {
    await db.credentials.put(c);
  }
  if (result.wallet) {
    if (payload.walletClientId) {
      await db.wallets.delete(payload.walletClientId);
    }
    await db.wallets.put({ ...result.wallet, syncStatus: "synced" });
  }
}

// Replaces the optimistic new-uid LocalCredential rows (keyed the same way
// applyProvisionCredentialResult's are) with the server-authoritative ones.
// The OLD rows need no cleanup here — they already carry their real server
// id from a previous pull, and were optimistically flipped to SUPERSEDED in
// place by the replace page itself; the next full pull (which now ships
// SUPERSEDED rows too, see pull/route.ts) reconciles them with the server's
// real supersededAt/supersededReason. No wallet touch — replacement never
// creates or changes a Wallet, only which uid points at the existing one.
async function applyReplaceCredentialResult(payload: any, result: any) {
  await db.credentials.delete(`${payload.clientId}-wallet`);
  await db.credentials.delete(`${payload.clientId}-ticket`);
  for (const c of result.credentials ?? []) {
    await db.credentials.put(c);
  }
}

// TOPUP_WALLET creates a genuine new local-id transaction row that needs
// remapping to its server id. Balance is only patched if the server says it
// actually changed (COMPLETED) — never trust an optimistic local increment
// for money.
async function applyTopupWalletResult(payload: any, result: any) {
  const localId = payload.clientId as string;
  await db.walletTransactions.delete(localId);
  await db.walletTransactions.put({ ...result.transaction, syncStatus: "synced" });
  if (result.wallet) {
    await db.wallets.put({ ...result.wallet, syncStatus: "synced" });
  }
}

// CHECK_TOPUP_STATUS acts on an already-synced transaction id (its own
// payload.clientId is just this op's idempotency key, not any local
// record's id) — no local-temp-id to remap, just an upsert-by-real-id.
async function applyCheckTopupStatusResult(_payload: any, result: any) {
  await db.walletTransactions.put({ ...result.transaction, syncStatus: "synced" });
  if (result.wallet) {
    await db.wallets.put({ ...result.wallet, syncStatus: "synced" });
  }
}

async function applyChargeWalletResult(payload: any, result: any) {
  const localId = payload.clientId as string;
  await db.walletTransactions.delete(localId);
  await db.walletTransactions.put({
    ...result.transaction,
    syncStatus: result.declined ? "conflict" : "synced",
    syncError: result.declined ? "Insufficient balance — declined." : null,
  });
  if (result.wallet) {
    await db.wallets.put({ ...result.wallet, syncStatus: "synced" });
  }
}

// WITHDRAW_WALLET creates a genuine new local-id transaction row, same
// remap shape as applyTopupWalletResult. "declined" here means the balance
// was insufficient (soft-decline, mirrors applyChargeWalletResult) — never
// a PENDING-awaiting-server-confirmation case like top-up, since the
// server resolves this synchronously (CAS-decrement, not an async provider
// callback).
async function applyWithdrawWalletResult(payload: any, result: any) {
  const localId = payload.clientId as string;
  await db.walletTransactions.delete(localId);
  await db.walletTransactions.put({
    ...result.transaction,
    syncStatus: result.declined ? "conflict" : "synced",
    syncError: result.declined ? "Insufficient balance — declined." : null,
  });
  if (result.wallet) {
    await db.wallets.put({ ...result.wallet, syncStatus: "synced" });
  }
}

// APPROVE_WITHDRAWAL acts on an already-synced transaction id — no
// local-temp-id to remap, same shape as applyCheckTopupStatusResult.
async function applyApproveWithdrawalResult(_payload: any, result: any) {
  await db.walletTransactions.put({ ...result.transaction, syncStatus: "synced" });
}

// REJECT_WITHDRAWAL also patches the wallet balance the reject refunded —
// mirrors applyChargeWalletResult's wallet-patch-if-present.
async function applyRejectWithdrawalResult(_payload: any, result: any) {
  await db.walletTransactions.put({ ...result.transaction, syncStatus: "synced" });
  if (result.wallet) {
    await db.wallets.put({ ...result.wallet, syncStatus: "synced" });
  }
}

async function applySponsorTapResult(payload: any, result: any) {
  const localId = payload.clientId as string;
  await db.walletTransactions.delete(localId);
  await db.walletTransactions.put({
    ...result.transaction,
    campaignRejectReason: result.campaignRejectReason ?? null,
    syncStatus: "synced",
  });
}

// Same delete-local-then-put-server shape as applyCreateSponsorResult.
async function applyAddSponsorCampaignResult(payload: any, result: any) {
  const localId = payload.clientId as string;
  await db.sponsorCampaigns.delete(localId);
  await db.sponsorCampaigns.put(result.campaign);
}

// Acts on an already-synced campaign id — no local-temp-id to remap, just
// an upsert-by-real-id (same discipline as applyVendorStatusResult).
async function applyDeactivateSponsorCampaignResult(_payload: any, result: any) {
  await db.sponsorCampaigns.put(result.campaign);
}

export async function flushOutbox(): Promise<{ flushed: number; failed: number }> {
  if (!db || !navigator.onLine) return { flushed: 0, failed: 0 };

  const entries = await db.outbox.where("status").anyOf("pending", "failed").sortBy("createdAt");
  let flushed = 0;
  let failed = 0;
  const deviceId = await getOrCreateDeviceId();

  for (const entry of entries) {
    if (entry.id == null) continue;
    await db.outbox.update(entry.id, { status: "syncing" });
    try {
      const res = await fetch("/api/sync/push", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(deviceId ? { "X-Device-Id": deviceId } : {}),
        },
        body: JSON.stringify({ type: entry.type, payload: entry.payload }),
      });
      const result = await res.json();

      if (!res.ok || !result.ok) {
        if (result.retry) {
          await db.outbox.update(entry.id, {
            status: "failed",
            attempts: entry.attempts + 1,
            lastError: result.reason ?? "sync failed",
          });
          failed++;
          continue;
        }
        // non-retryable: drop from outbox but record conflict on the local record if we can
        await db.outbox.delete(entry.id);
        failed++;
        continue;
      }

      switch (entry.type) {
        case "CREATE_EVENT":
          await applyCreateEventResult(entry.payload, result);
          break;
        case "SELL_TICKETS":
          await applySellTicketsResult(entry.payload, result);
          break;
        case "CHECK_IN":
          await applyCheckInResult(entry.payload, result);
          break;
        case "ADD_MOBILE_MONEY_ACCOUNT":
          await applyMobileMoneyResult(entry.payload, result);
          break;
        case "EDIT_EVENT":
        case "CANCEL_EVENT":
          await applyEditOrCancelEventResult(entry.payload, result);
          break;
        case "REFUND_ORDER":
          await applyRefundOrderResult(entry.payload, result);
          break;
        case "APPLY_VENDOR":
        case "ADD_VENDOR":
          await applyCreateVendorResult(entry.payload, result);
          break;
        case "APPROVE_VENDOR":
        case "REJECT_VENDOR":
          await applyVendorStatusResult(entry.payload, result);
          break;
        case "CHECK_IN_VENDOR":
          await applyCheckInVendorResult(entry.payload, result);
          break;
        case "ADD_SPONSOR":
          await applyCreateSponsorResult(entry.payload, result);
          break;
        case "CREATE_WALLET":
          await applyCreateWalletResult(entry.payload, result);
          break;
        case "PROVISION_CREDENTIAL":
          await applyProvisionCredentialResult(entry.payload, result);
          break;
        case "REPLACE_CREDENTIAL":
          await applyReplaceCredentialResult(entry.payload, result);
          break;
        case "TOPUP_WALLET":
          await applyTopupWalletResult(entry.payload, result);
          break;
        case "CHECK_TOPUP_STATUS":
          await applyCheckTopupStatusResult(entry.payload, result);
          break;
        case "CHECK_ORDER_PAYMENT_STATUS":
          await applyCheckOrderPaymentStatusResult(entry.payload, result);
          break;
        case "CHARGE_WALLET":
          await applyChargeWalletResult(entry.payload, result);
          break;
        case "WITHDRAW_WALLET":
          await applyWithdrawWalletResult(entry.payload, result);
          break;
        case "APPROVE_WITHDRAWAL":
          await applyApproveWithdrawalResult(entry.payload, result);
          break;
        case "REJECT_WITHDRAWAL":
          await applyRejectWithdrawalResult(entry.payload, result);
          break;
        case "SPONSOR_TAP":
          await applySponsorTapResult(entry.payload, result);
          break;
        case "ADD_SPONSOR_CAMPAIGN":
          await applyAddSponsorCampaignResult(entry.payload, result);
          break;
        case "DEACTIVATE_SPONSOR_CAMPAIGN":
          await applyDeactivateSponsorCampaignResult(entry.payload, result);
          break;
      }

      await db.outbox.delete(entry.id);
      flushed++;
    } catch {
      await db.outbox.update(entry.id, {
        status: "failed",
        attempts: entry.attempts + 1,
        lastError: "network error",
      });
      failed++;
    }
  }

  return { flushed, failed };
}

// ---------- orchestration ----------

let flushScheduled = false;
function scheduleFlush() {
  if (flushScheduled || typeof window === "undefined") return;
  flushScheduled = true;
  setTimeout(async () => {
    flushScheduled = false;
    if (navigator.onLine) {
      await flushOutbox();
      await pullFromServer();
      notifySyncListeners();
    }
  }, 300);
}

const syncListeners = new Set<() => void>();
export function onSyncTick(cb: () => void) {
  syncListeners.add(cb);
  return () => {
    syncListeners.delete(cb);
  };
}
function notifySyncListeners() {
  syncListeners.forEach((cb) => cb());
}

let autoSyncStarted = false;
export function startAutoSync() {
  if (autoSyncStarted || typeof window === "undefined") return;
  autoSyncStarted = true;

  const run = async () => {
    if (!navigator.onLine) return;
    await flushOutbox();
    await pullFromServer();
    notifySyncListeners();
  };

  window.addEventListener("online", run);
  run();
  setInterval(run, 20000);
}

export { newLocalId };
