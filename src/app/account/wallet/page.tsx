"use client";

import { useEffect, useState } from "react";
import { useLiveQuery } from "dexie-react-hooks";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { db, newLocalId, type LocalWallet } from "@/lib/db";
import { queueOp } from "@/lib/sync-engine";
import { useAppSession } from "@/lib/use-app-session";
import { formatCents, generateTicketCode } from "@/lib/format";
import { findCarryOverCandidate } from "@/lib/carry-over";

export default function WalletListPage() {
  const { user, status } = useAppSession();
  const router = useRouter();
  const [registering, setRegistering] = useState<string | null>(null);

  const wallets = useLiveQuery(async () => {
    if (!user) return [];
    return db.wallets.where("ownerUserId").equals(user.id).toArray();
  }, [user?.id]);

  const allEvents = useLiveQuery(() => db.events.toArray(), []);
  const liveEvents =
    allEvents === undefined
      ? undefined
      : allEvents
          .filter((e) => e.status === "LIVE")
          .sort((a, b) => (a.startsAt < b.startsAt ? -1 : 1));

  useEffect(() => {
    if (status !== "loading" && !user) router.push("/login?callbackUrl=/account/wallet");
  }, [status, user, router]);

  if (!user) return null;

  const walletsByEventId = new Map((wallets ?? []).map((w) => [w.eventId, w]));

  async function registerWallet(eventId: string, eventClientId: string | null | undefined) {
    if (!user) return;
    setRegistering(eventId);
    const clientId = newLocalId();
    const code = generateTicketCode();
    const event = (allEvents ?? []).find((e) => e.id === eventId);

    // Session 11 — offer to carry a positive balance over from a wallet at
    // a previous, already-ended event by the same organiser. Everything
    // needed to decide is already in the buyer's local Dexie (their own
    // wallets + every event); the server re-verifies on sync regardless.
    let carryOver: { sourceWalletId: string } | null = null;
    if (event?.carryOverEnabled) {
      const candidate = findCarryOverCandidate({
        targetEvent: event,
        wallets: (wallets ?? [])
          .map((w) => {
            const wEvent = (allEvents ?? []).find((e) => e.id === w.eventId);
            return wEvent ? { wallet: w, event: wEvent } : null;
          })
          .filter((x): x is NonNullable<typeof x> => x !== null),
      });
      if (candidate) {
        const accepted = window.confirm(
          `You have ${formatCents(candidate.balanceCents, candidate.currency)} remaining from ${candidate.sourceEventTitle}. Would you like to use it at this event?`
        );
        if (accepted) carryOver = { sourceWalletId: candidate.sourceWalletId };
      }
    }

    const wallet: LocalWallet = {
      id: clientId,
      clientId,
      code,
      eventId,
      eventClientId: eventClientId ?? null,
      ownerUserId: user.id,
      ownerName: user.name ?? null,
      ownerEmail: user.email ?? null,
      // Optimistically a plain zero-balance wallet either way — the real
      // carried figure and the source wallet's zeroing land via
      // applyCarryOverWalletResult once the op syncs, so a server-side
      // decline can't leave a phantom balance showing locally.
      balanceCents: 0,
      currency: event?.currency ?? "TZS",
      carryOverSourceWalletId: carryOver?.sourceWalletId ?? null,
      carryOverredAt: null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      syncStatus: "pending",
    };
    await db.wallets.put(wallet);
    if (carryOver) {
      await queueOp("CARRY_OVER_WALLET", {
        clientId,
        code,
        eventId,
        eventClientId,
        sourceWalletId: carryOver.sourceWalletId,
      });
    } else {
      await queueOp("CREATE_WALLET", { clientId, code, eventId, eventClientId });
    }
    setRegistering(null);
  }

  return (
    <div className="mx-auto max-w-3xl px-4 pb-20 pt-8 sm:px-6">
      <h1 className="mb-1 text-2xl font-bold">My Wallets</h1>
      <p className="mb-6 text-sm text-muted">
        A cashless balance you top up and spend with vendors at an event —
        works alongside your tickets.
      </p>

      {liveEvents === undefined ? (
        <div className="space-y-3">
          {Array.from({ length: 2 }).map((_, i) => (
            <div key={i} className="card h-20 animate-pulse bg-surface2" />
          ))}
        </div>
      ) : liveEvents.length === 0 ? (
        <div className="card p-10 text-center text-muted">
          No live events yet. <Link href="/" className="text-accent-hover">Browse events</Link>
        </div>
      ) : (
        <div className="space-y-3">
          {liveEvents.map((event) => {
            const wallet = walletsByEventId.get(event.id);
            return (
              <div key={event.id} className="card flex items-center justify-between p-4">
                <div>
                  <p className="font-semibold">
                    {event.title}
                    {wallet?.isGroupWallet && <span className="pill ml-2">Group</span>}
                  </p>
                  {wallet ? (
                    <p className="text-sm text-muted">{formatCents(wallet.balanceCents, wallet.currency)} balance</p>
                  ) : (
                    <p className="text-sm text-muted">No wallet yet</p>
                  )}
                </div>
                {wallet ? (
                  <Link href={`/account/wallet/${wallet.id}`} className="btn-secondary">View</Link>
                ) : (
                  <button
                    className="btn-primary"
                    disabled={registering === event.id}
                    onClick={() => registerWallet(event.id, event.clientId)}
                  >
                    {registering === event.id ? "Registering…" : "Register"}
                  </button>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
