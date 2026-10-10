"use client";

import { useEffect, useState } from "react";
import { useLiveQuery } from "dexie-react-hooks";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { db, newLocalId, type LocalWallet } from "@/lib/db";
import { queueOp } from "@/lib/sync-engine";
import { useAppSession } from "@/lib/use-app-session";
import { useTranslation } from "@/lib/use-translation";
import { formatCents, generateTicketCode } from "@/lib/format";
import { findCarryOverCandidate, type CarryOverCandidate } from "@/lib/carry-over";
import { SkeletonList } from "@/components/Skeleton";

interface PendingCarryOver {
  eventId: string;
  eventClientId: string | null | undefined;
  candidate: CarryOverCandidate;
}

export default function WalletListPage() {
  const { user, status } = useAppSession();
  const router = useRouter();
  const { t } = useTranslation();
  const [registering, setRegistering] = useState<string | null>(null);
  // Carry-over confirmation (see registerWallet below) used to be a native
  // window.confirm() — the only spot in the attendee app that broke out of
  // the themed UI into a browser-chrome dialog. This renders the same
  // decision as an in-card prompt instead, matching how every other
  // confirmation in the app (e.g. the wallet-transfer "confirm & send" step)
  // is handled.
  const [pendingCarryOver, setPendingCarryOver] = useState<PendingCarryOver | null>(null);

  const wallets = useLiveQuery(async () => {
    if (!user) return [];
    return db.wallets.where("ownerUserId").equals(user.id).toArray();
  }, [user?.id]);

  // Scoped to events the buyer actually has a reason to see here — an order
  // (their own, or a ticket transferred to them) — not every live event on
  // the platform. Mirrors account/tickets' identical ownership check; a
  // global event dump here showed every organiser's events once the
  // platform had more than a handful live, including unrelated ones.
  const myEventIds = useLiveQuery(async () => {
    if (!user) return new Set<string>();
    const orders = await db.orders.toArray();
    const ids = new Set<string>();
    for (const o of orders) {
      if (o.userId === user.id || o.tickets.some((t) => t.currentHolderUserId === user.id)) {
        ids.add(o.eventId);
      }
    }
    return ids;
  }, [user?.id]);

  const allEvents = useLiveQuery(() => db.events.toArray(), []);
  const liveEvents =
    allEvents === undefined || myEventIds === undefined || wallets === undefined
      ? undefined
      : allEvents
          .filter((e) => e.status === "LIVE" && (myEventIds.has(e.id) || wallets.some((w) => w.eventId === e.id)))
          .sort((a, b) => (a.startsAt < b.startsAt ? -1 : 1));

  useEffect(() => {
    if (status !== "loading" && !user) router.push("/login?callbackUrl=/account/wallet");
  }, [status, user, router]);

  if (!user) return null;

  const walletsByEventId = new Map((wallets ?? []).map((w) => [w.eventId, w]));

  // Session 11 — offer to carry a positive balance over from a wallet at a
  // previous, already-ended event by the same organiser. Everything needed
  // to decide is already in the buyer's local Dexie (their own wallets +
  // every event); the server re-verifies on sync regardless. A candidate
  // routes to the in-card confirm prompt below instead of registering
  // immediately; no candidate registers straight away.
  function registerWallet(eventId: string, eventClientId: string | null | undefined) {
    if (!user) return;
    const event = (allEvents ?? []).find((e) => e.id === eventId);

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
        setPendingCarryOver({ eventId, eventClientId, candidate });
        return;
      }
    }

    void finishRegistration(eventId, eventClientId, null);
  }

  function confirmCarryOver(accept: boolean) {
    if (!pendingCarryOver) return;
    const { eventId, eventClientId, candidate } = pendingCarryOver;
    setPendingCarryOver(null);
    void finishRegistration(eventId, eventClientId, accept ? { sourceWalletId: candidate.sourceWalletId } : null);
  }

  async function finishRegistration(
    eventId: string,
    eventClientId: string | null | undefined,
    carryOver: { sourceWalletId: string } | null
  ) {
    if (!user) return;
    setRegistering(eventId);
    const clientId = newLocalId();
    const code = generateTicketCode();
    const event = (allEvents ?? []).find((e) => e.id === eventId);

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
        <SkeletonList rows={2} />
      ) : liveEvents.length === 0 ? (
        <div className="card p-10 text-center text-muted">
          No wallets yet — buy a ticket to a live event to register one. <Link href="/" className="text-accent-hover">Browse events</Link>
        </div>
      ) : (
        <div className="space-y-3">
          {liveEvents.map((event) => {
            const wallet = walletsByEventId.get(event.id);
            const prompting = pendingCarryOver?.eventId === event.id ? pendingCarryOver : null;
            return (
              <div key={event.id} className={`card p-4 ${prompting ? "space-y-3" : "flex items-center justify-between"}`}>
                {/* "contents" makes this wrapper invisible to layout, so its
                    two children become direct flex items of the card above
                    (title block + action) when not prompting — same two-item
                    spacing as before this row could also show a prompt. */}
                <div className={prompting ? "flex items-center justify-between" : "contents"}>
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
                  {!prompting &&
                    (wallet ? (
                      <Link href={`/account/wallet/${wallet.id}`} className="btn-secondary">View</Link>
                    ) : (
                      <button
                        className="btn-primary"
                        disabled={registering === event.id}
                        onClick={() => registerWallet(event.id, event.clientId)}
                      >
                        {registering === event.id ? "Registering…" : "Register"}
                      </button>
                    ))}
                </div>
                {prompting && (
                  <div className="rounded-lg border border-accent/40 bg-accent-soft p-3 text-sm">
                    <p className="text-foreground">
                      {t("walletAccount.carryOverPrompt", {
                        amount: formatCents(prompting.candidate.balanceCents, prompting.candidate.currency),
                        eventTitle: prompting.candidate.sourceEventTitle,
                      })}
                    </p>
                    <div className="mt-3 flex gap-2">
                      <button className="btn-secondary flex-1" onClick={() => confirmCarryOver(false)}>
                        Start fresh
                      </button>
                      <button className="btn-primary flex-1" onClick={() => confirmCarryOver(true)}>
                        Carry over
                      </button>
                    </div>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
