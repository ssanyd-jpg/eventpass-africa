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
  type LocalTimingPoint,
  type LocalConferenceSession,
  type LocalDirectSaleTransaction,
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
    // Session 22 — TWO separate delta-sync cursors, matching the pull
    // route's own two independent cursors (see its header comment for why
    // one shared cursor is actually wrong, not just simpler): `lastSyncedAt`
    // covers the public `events` field, which the route fills on every
    // request regardless of session; `lastAuthSyncedAt` covers everything
    // that only exists once logged in (myOrders/myVendors/myWallets/etc.)
    // and must never be sent — nor advanced — from a pull made before this
    // browser had ever actually pulled that data at all (an anonymous pull,
    // or the very first pull right after logging in). Every table either
    // cursor gates merges via bulkPut/upsert-by-clientId already (see
    // below), so receiving a subset here is exactly as correct as receiving
    // everything — nothing gets removed either way.
    const lastSyncedAt = await db.meta.get("lastSyncedAt");
    const since = typeof lastSyncedAt?.value === "string" ? lastSyncedAt.value : null;
    const lastAuthSyncedAt = await db.meta.get("lastAuthSyncedAt");
    const sinceAuth = typeof lastAuthSyncedAt?.value === "string" ? lastAuthSyncedAt.value : null;
    const params = new URLSearchParams();
    if (since) params.set("since", since);
    if (sinceAuth) params.set("sinceAuth", sinceAuth);
    const query = params.toString();
    const url = query ? `/api/sync/pull?${query}` : "/api/sync/pull";
    const res = await fetch(url, {
      cache: "no-store",
      headers: deviceId ? { "X-Device-Id": deviceId } : undefined,
    });
    if (!res.ok) return { ok: false };
    const data = await res.json();
    // Signals the response actually included the authenticated block (the
    // pull route only ever sets this key inside its `if (session?.user?.id
    // ...)` branch) — the gate the auth cursor's advance below is keyed on.
    const gotAuthData = Array.isArray(data.myOrders);

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

    // Session 12 — same full-replace discipline as credentials above: a
    // small, organiser/staff-scoped dataset with no per-item merge
    // complexity worth doing.
    if (Array.isArray(data.myTimingPoints)) {
      await db.timingPoints.clear();
      await db.timingPoints.bulkPut(data.myTimingPoints as LocalTimingPoint[]);
    }

    // Session 19 — same full-replace discipline as timingPoints above,
    // including the live attendanceCount aggregate (see myConferenceSessions
    // in pull/route.ts) so the session scanner's "attendees in the room"
    // count stays current on every ~20s pull, not just this device's own taps.
    if (Array.isArray(data.myConferenceSessions)) {
      await db.conferenceSessions.clear();
      await db.conferenceSessions.bulkPut(data.myConferenceSessions as LocalConferenceSession[]);
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

    // Session 28 — same delete-if-remapped-then-put-by-clientId merge as
    // myWalletTransactions above, for the standalone Direct Sale table.
    if (Array.isArray(data.myDirectSaleTransactions)) {
      for (const t of data.myDirectSaleTransactions as LocalDirectSaleTransaction[]) {
        const existing = await db.directSaleTransactions
          .where("clientId")
          .equals(t.clientId ?? "")
          .first();
        if (existing && existing.id !== t.id) {
          await db.directSaleTransactions.delete(existing.id);
        }
        await db.directSaleTransactions.put({ ...t, syncStatus: "synced" });
      }
    }

    // The SERVER's clock, not the client's — this value becomes the next
    // request's `since`/`sinceAuth`, compared against `updatedAt` columns
    // that were themselves stamped by the server's clock. Using the
    // client's own clock here would silently lose rows under any client/
    // server clock drift where the client runs ahead.
    if (typeof data.now === "string") {
      await db.meta.put({ key: "lastSyncedAt", value: data.now });
      // Only advance the auth cursor from a response that actually carried
      // the authenticated block — an anonymous pull (or a pull made right
      // as a session is ending) must never advance this, or the next
      // login's first pull would wrongly delta-filter data it has never
      // actually fetched (see this function's own header comment).
      if (gotAuthData) {
        await db.meta.put({ key: "lastAuthSyncedAt", value: data.now });
      }
    }
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

  // Session 13 — group checkout creates (or reuses) a shared Wallet
  // transparently, with no separate CREATE_WALLET op of its own: write it
  // into the buyer's local wallets table now so its code/balance are
  // available on this device immediately, without waiting for the next pull.
  if (result.sharedWallet) {
    await db.wallets.put({ ...result.sharedWallet, syncStatus: "synced" });
  }
}

// Mirrors applyRefundOrderResult — acts on an already-synced order id (no
// local-temp-id remap needed), and patches the cached event's
// ticketTypes[].quantitySold when the FAILED branch released inventory.
// Reused as-is for CANCEL_PENDING_ORDER and MARK_ORDER_PAID below: both are
// the exact same "order transitioned, maybe inventory changed" shape as a
// PENDING poll result, just triggered by the buyer or organizer instead of
// an Airpay check.
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

// Session 11: swaps the optimistic local wallet for the server row (same as
// applyCreateWalletResult) AND writes back the now-zeroed source wallet, so
// the buyer's wallet list reflects the moved balance immediately without
// waiting for the next pull. On a soft-fail (carry-over declined
// server-side, or a mid-flight balance change), result.wallet is absent —
// leave the optimistic rows for flushOutbox's normal retry/conflict path.
async function applyCarryOverWalletResult(payload: any, result: any) {
  if (!result?.ok || !result.wallet) return;
  const localId = payload.clientId as string;
  await db.wallets.delete(localId);
  await db.wallets.put({ ...result.wallet, syncStatus: "synced" });
  if (result.sourceWallet) {
    await db.wallets.put({ ...result.sourceWallet, syncStatus: "synced" });
  }
}

// Session 12 — replaces the optimistic local chip-time row (if the scanner
// wrote one) with the server-authoritative one, carrying the real
// gunTimeOffsetSeconds/splitTimeSeconds. See LocalChipTime's own comment
// for why this table is local-activity-feed-only, never pull-synced.
async function applyRecordChipTimeResult(payload: any, result: any) {
  if (!result?.ok || !result.chipTime) return;
  const localId = payload.clientId as string;
  await db.chipTimes.delete(localId);
  await db.chipTimes.put({ ...result.chipTime, syncStatus: "synced" });
}

// Same optimistic-placeholder-replacement shape as applyRecordChipTimeResult
// above — see the session scanner page for the optimistic LocalSessionAttendance
// row this replaces.
async function applyRecordSessionAttendanceResult(payload: any, result: any) {
  if (!result?.ok || !result.attendance) return;
  const localId = payload.clientId as string;
  await db.sessionAttendances.delete(localId);
  await db.sessionAttendances.put({ ...result.attendance, syncStatus: "synced" });
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

// SPLIT_PAYMENT is non-optimistic (same reasoning as applyChargeWalletResult
// — a declined-after-the-fact charge is a real loss, so the terminal waits
// for the actual result rather than showing "approved" early) and produces
// up to two genuine new server rows: the SALE (keyed by payload.clientId,
// remapped the same way applyChargeWalletResult remaps its one row) and,
// when the wallet's own balance didn't already cover it, a sibling TOPUP
// (keyed by payload.clientId + "-topup", same suffix convention
// handleSplitPayment uses server-side). No local-temp-id exists for the
// TOPUP since nothing was queued optimistically under that key — this is
// just its first-ever local write.
async function applySplitPaymentResult(payload: any, result: any) {
  const localId = payload.clientId as string;
  await db.walletTransactions.delete(localId);
  await db.walletTransactions.put({
    ...result.transaction,
    syncStatus: result.declined ? "conflict" : "synced",
    syncError: result.declined ? (result.transaction.providerMessage ?? "Declined.") : null,
  });
  if (result.topupTransaction) {
    await db.walletTransactions.put({ ...result.topupTransaction, syncStatus: "synced" });
  }
  if (result.wallet) {
    await db.wallets.put({ ...result.wallet, syncStatus: "synced" });
  }
}

// CHARGE_DIRECT_SALE creates a genuine new local-id transaction row that
// needs remapping to its server id, same shape as applyTopupWalletResult —
// no wallet to patch, since Direct Sale never touches one.
async function applyChargeDirectSaleResult(payload: any, result: any) {
  if (!result?.ok || !result.transaction) return;
  const localId = payload.clientId as string;
  await db.directSaleTransactions.delete(localId);
  await db.directSaleTransactions.put({ ...result.transaction, syncStatus: "synced" });
}

// CHECK_DIRECT_SALE_STATUS/CANCEL_DIRECT_SALE act on an already-synced
// transaction id — no local-temp-id to remap, just an upsert-by-real-id,
// same shape as applyCheckTopupStatusResult.
async function applyCheckDirectSaleStatusResult(_payload: any, result: any) {
  if (!result?.ok || !result.transaction) return;
  await db.directSaleTransactions.put({ ...result.transaction, syncStatus: "synced" });
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

// Session 22 — which resource an outbox entry mutates, so independent
// entries (different wallets, different tickets) can flush concurrently
// while anything sharing a resource keeps today's exact one-at-a-time,
// createdAt order (a second charge against the SAME wallet must never
// race the first). Only the op types the audit actually confirmed are
// pairwise-independent by resource get a real key; every other type
// (event lifecycle, vendor/sponsor approvals, credential replacement,
// withdrawal approvals, mobile money accounts, sponsor campaigns — all
// low-volume, staff-desk actions, not a busy gate/wallet terminal's hot
// path) shares one bucket and keeps its current fully-sequential behavior.
//
// A bucket-key mismatch is self-healing, not corrupting: an op referencing
// a not-yet-synced wallet/ticket (by its local clientId) that happens to
// run in a different bucket than the op that creates it simply gets back
// `retry:true` from the server (the same fallback every clientId-resolved
// op already relies on) and is retried on the next flush cycle.
function outboxResourceKey(entry: { type: OutboxOpType; payload: Record<string, unknown>; id?: number }): string {
  const p = entry.payload;
  switch (entry.type) {
    case "TOPUP_WALLET":
    case "WITHDRAW_WALLET":
      return `wallet:${p.walletId}`;
    case "CHARGE_WALLET":
    case "SPLIT_PAYMENT":
    case "SPONSOR_TAP":
      return `wallet:${p.walletCode}`;
    // Session 28 — CHECK/CANCEL reference the CHARGE's own clientId (the
    // transaction's id, not the check/cancel op's own), so all three stay
    // bucketed together against the SAME direct sale — a different walk-up
    // customer's direct sale gets its own bucket and can flush concurrently.
    case "CHARGE_DIRECT_SALE":
      return `directsale:${p.clientId}`;
    case "CHECK_DIRECT_SALE_STATUS":
    case "CANCEL_DIRECT_SALE":
      return `directsale:${p.directSaleClientId ?? p.directSaleId}`;
    case "CHECK_IN":
      return `ticket:${p.ticketCode}`;
    case "CHECK_IN_VENDOR":
      return `vendor:${p.badgeCode}`;
    case "RECORD_CHIP_TIME":
    case "RECORD_SESSION_ATTENDANCE":
      // Keyed by whichever of nfcUid/ticketCode this tap resolved by (the
      // payload always carries exactly one — see the zod schema's own
      // superRefine) — two taps of the SAME tag stay ordered, two different
      // athletes'/attendees' taps don't.
      return `credential:${p.nfcUid ?? p.ticketCode ?? entry.id}`;
    case "SELL_TICKETS":
      // Every purchase is its own order — never shares a wallet/ticket with
      // another SELL_TICKETS entry, so each gets its own one-entry bucket.
      return `sell:${entry.id}`;
    default:
      return "__serial__";
  }
}

export async function flushOutbox(): Promise<{ flushed: number; failed: number }> {
  if (!db || !navigator.onLine) return { flushed: 0, failed: 0 };

  const entries = await db.outbox.where("status").anyOf("pending", "failed").sortBy("createdAt");
  let flushed = 0;
  let failed = 0;
  const deviceId = await getOrCreateDeviceId();

  const buckets = new Map<string, typeof entries>();
  for (const entry of entries) {
    const key = outboxResourceKey(entry);
    const bucket = buckets.get(key);
    if (bucket) {
      bucket.push(entry);
    } else {
      buckets.set(key, [entry]);
    }
  }

  async function processEntry(entry: (typeof entries)[number]) {
    if (entry.id == null) return;
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
          return;
        }
        // non-retryable: drop from outbox but record conflict on the local record if we can
        await db.outbox.delete(entry.id);
        failed++;
        return;
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
        case "CARRY_OVER_WALLET":
          await applyCarryOverWalletResult(entry.payload, result);
          break;
        case "RECORD_CHIP_TIME":
          await applyRecordChipTimeResult(entry.payload, result);
          break;
        case "RECORD_SESSION_ATTENDANCE":
          await applyRecordSessionAttendanceResult(entry.payload, result);
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
        case "CANCEL_PENDING_ORDER":
        case "MARK_ORDER_PAID":
          await applyCheckOrderPaymentStatusResult(entry.payload, result);
          break;
        case "CHARGE_WALLET":
          await applyChargeWalletResult(entry.payload, result);
          break;
        case "SPLIT_PAYMENT":
          await applySplitPaymentResult(entry.payload, result);
          break;
        case "CHARGE_DIRECT_SALE":
          await applyChargeDirectSaleResult(entry.payload, result);
          break;
        case "CHECK_DIRECT_SALE_STATUS":
        case "CANCEL_DIRECT_SALE":
          await applyCheckDirectSaleStatusResult(entry.payload, result);
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

  // Entries within a bucket run strictly in order (a plain for-loop,
  // identical to the old single-queue behavior); different buckets run
  // concurrently via Promise.all — the counters above are safe to share
  // across them despite the concurrency: JS never interleaves two `flushed++`
  // mid-increment, only between `await` points.
  await Promise.all(
    Array.from(buckets.values()).map(async (bucket) => {
      for (const entry of bucket) {
        await processEntry(entry);
      }
    })
  );

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
