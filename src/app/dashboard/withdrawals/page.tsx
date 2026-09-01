"use client";

import { useEffect, useState } from "react";
import { useLiveQuery } from "dexie-react-hooks";
import { useRouter } from "next/navigation";
import { db, newLocalId, type LocalWalletTransaction } from "@/lib/db";
import { queueOp } from "@/lib/sync-engine";
import { useAppSession } from "@/lib/use-app-session";
import { formatCents, formatDateTime } from "@/lib/format";

const NETWORK_LABEL: Record<string, string> = {
  MPESA: "M-Pesa",
  TIGO: "Tigo Pesa",
  AIRTEL: "Airtel Money",
  HALOTEL: "HaloPesa",
};

// Cross-event, org-wide — mirrors dashboard/support's top-level placement
// (organizers need a single queue for something time-sensitive, not one
// scattered per event), but Dexie-driven/queueOp like
// dashboard/events/[id]/vendors/page.tsx, since APPROVE_WITHDRAWAL/
// REJECT_WITHDRAWAL are sync ops, not Server Actions.
export default function WithdrawalsPage() {
  const router = useRouter();
  const { user } = useAppSession();

  // Middleware already redirects GATE_CREW away from this route server-side
  // — this is defense-in-depth for a device offline with an already-cached
  // page shell (see src/middleware.ts).
  useEffect(() => {
    if (user?.organizationRole === "GATE_CREW") router.replace("/dashboard");
  }, [user, router]);

  const pending = useLiveQuery(async () => {
    const all = await db.walletTransactions.where("type").equals("WITHDRAWAL").toArray();
    return all.filter((t) => t.status === "PENDING").sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
  }, [], []);
  const wallets = useLiveQuery(() => db.wallets.toArray(), [], []);
  const walletsById = new Map((wallets ?? []).map((w) => [w.id, w]));

  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  if (user?.organizationRole === "GATE_CREW") return null;

  async function approve(t: LocalWalletTransaction) {
    setError(null);
    setBusyId(t.id);
    try {
      await db.walletTransactions.put({ ...t, status: "COMPLETED", syncStatus: "pending" });
      await queueOp("APPROVE_WITHDRAWAL", {
        clientId: newLocalId(),
        walletTransactionId: t.id,
        walletTransactionClientId: t.clientId,
      });
    } finally {
      setBusyId(null);
    }
  }

  async function reject(t: LocalWalletTransaction) {
    const reason = window.prompt("Reason for rejecting (optional):") ?? undefined;
    setError(null);
    setBusyId(t.id);
    try {
      const wallet = walletsById.get(t.walletId);
      await db.walletTransactions.put({ ...t, status: "FAILED", providerMessage: reason ?? null, syncStatus: "pending" });
      if (wallet) {
        await db.wallets.put({ ...wallet, balanceCents: wallet.balanceCents + (t.amountCents ?? 0), syncStatus: "pending" });
      }
      await queueOp("REJECT_WITHDRAWAL", {
        clientId: newLocalId(),
        walletTransactionId: t.id,
        walletTransactionClientId: t.clientId,
        reason,
      });
    } finally {
      setBusyId(null);
    }
  }

  return (
    <div className="mx-auto max-w-3xl px-4 pb-20 pt-8 sm:px-6">
      <h1 className="mb-1 text-2xl font-bold">Withdrawals</h1>
      <p className="mb-6 text-sm text-muted">
        Buyers cashing out leftover wallet balance. No automated payout
        exists yet — approving means you&apos;ve paid the buyer out
        yourself via mobile money or cash; rejecting returns the balance to
        their wallet.
      </p>

      {error && <p className="mb-4 text-sm text-danger">{error}</p>}

      {(pending ?? []).length === 0 ? (
        <div className="card p-8 text-center text-muted">No pending withdrawal requests.</div>
      ) : (
        <div className="card divide-y divide-border">
          {(pending ?? []).map((t) => {
            const wallet = walletsById.get(t.walletId);
            return (
              <div key={t.id} className="flex flex-wrap items-center justify-between gap-3 p-4 text-sm">
                <div>
                  <p className="font-medium">
                    {wallet?.ownerName ?? "Unknown buyer"}
                    <span className="ml-2 font-semibold">{formatCents(t.amountCents ?? 0, t.currency)}</span>
                  </p>
                  <p className="text-xs text-muted">{wallet?.ownerEmail}</p>
                  <p className="mt-1 text-xs text-muted">
                    {t.phoneNumber} · {t.mobileNetwork ? NETWORK_LABEL[t.mobileNetwork] ?? t.mobileNetwork : "—"} ·{" "}
                    {formatDateTime(t.createdAt)}
                  </p>
                </div>
                <div className="flex gap-2">
                  <button
                    className="text-xs font-medium text-danger hover:underline disabled:opacity-50"
                    disabled={busyId === t.id}
                    onClick={() => reject(t)}
                  >
                    Reject
                  </button>
                  <button
                    className="btn-primary !px-3 !py-1.5 text-xs disabled:opacity-50"
                    disabled={busyId === t.id}
                    onClick={() => approve(t)}
                  >
                    {busyId === t.id ? "…" : "Mark paid"}
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
