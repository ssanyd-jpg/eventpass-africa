"use client";

import { useEffect, useState, useSyncExternalStore } from "react";
import {
  db,
  newLocalId,
  type LocalEvent,
  type LocalOrder,
  type LocalVendor,
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
    const res = await fetch("/api/sync/pull", { cache: "no-store" });
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
  await db.orders.delete(localId);
  await db.orders.put({
    ...server,
    syncStatus: result.oversold ? "conflict" : "synced",
    syncError: result.oversold ? "Some items exceeded remaining capacity — organizer review needed." : null,
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

export async function flushOutbox(): Promise<{ flushed: number; failed: number }> {
  if (!db || !navigator.onLine) return { flushed: 0, failed: 0 };

  const entries = await db.outbox.where("status").anyOf("pending", "failed").sortBy("createdAt");
  let flushed = 0;
  let failed = 0;

  for (const entry of entries) {
    if (entry.id == null) continue;
    await db.outbox.update(entry.id, { status: "syncing" });
    try {
      const res = await fetch("/api/sync/push", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
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
