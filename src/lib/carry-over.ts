// Pure, DB-free helpers for Session 11's wristband balance carry-over.
// Same testability convention as forecast.ts / analytics.ts: no Prisma, no
// fetch — the client feeds in the rows it already has in Dexie, and the
// server-side handler (handleCarryOverWallet in sync-handlers.ts) re-checks
// everything against the database regardless.

// An event has "ended" for carry-over purposes once its end datetime is in
// the past. endsAt is optional (Session 11 added it); when it isn't set,
// startsAt stands in — correct for the single-day events that dominate.
export function eventHasEnded(
  event: { startsAt: string | Date; endsAt?: string | Date | null },
  now: Date = new Date()
): boolean {
  const end = event.endsAt ?? event.startsAt;
  return new Date(end).getTime() < now.getTime();
}

export interface CarryOverWalletInput {
  id: string;
  eventId: string;
  balanceCents: number;
  currency: string;
  // Already carried FROM somewhere? A wallet can only be a carry-over
  // source once — its balance is zeroed after, so this is belt-and-braces.
  carryOverSourceWalletId?: string | null;
}

export interface CarryOverEventInput {
  id: string;
  organizationId: string;
  currency: string;
  startsAt: string | Date;
  endsAt?: string | Date | null;
  carryOverEnabled: boolean;
}

export interface CarryOverCandidate {
  sourceWalletId: string;
  sourceEventId: string;
  sourceEventTitle: string;
  balanceCents: number;
  currency: string;
}

// Given the event a buyer is about to register a wallet for, and every
// wallet they already hold (each paired with its event), return the single
// best source to offer them for carry-over — or null if nothing qualifies.
// "Best" = the highest balance among all eligible sources.
export function findCarryOverCandidate(params: {
  targetEvent: CarryOverEventInput;
  wallets: { wallet: CarryOverWalletInput; event: CarryOverEventInput & { title: string } }[];
  now?: Date;
}): CarryOverCandidate | null {
  const { targetEvent, wallets } = params;
  const now = params.now ?? new Date();

  if (!targetEvent.carryOverEnabled) return null;

  const eligible = wallets
    .filter(({ wallet, event }) => {
      if (event.id === targetEvent.id) return false; // not the same event
      if (event.organizationId !== targetEvent.organizationId) return false; // same organiser only
      if (event.currency !== targetEvent.currency) return false; // no cross-currency carry
      if (wallet.balanceCents <= 0) return false; // nothing to carry
      if (!eventHasEnded(event, now)) return false; // previous event must be over
      return true;
    })
    .sort((a, b) => b.wallet.balanceCents - a.wallet.balanceCents);

  const best = eligible[0];
  if (!best) return null;

  return {
    sourceWalletId: best.wallet.id,
    sourceEventId: best.event.id,
    sourceEventTitle: best.event.title,
    balanceCents: best.wallet.balanceCents,
    currency: best.wallet.currency,
  };
}

// Total carry-over volume for the organiser analytics cashless section:
// the sum of CARRY_OVER *credits* (positive rows — the balance that landed
// on a new wallet), partitioned by currency like every other volume figure
// in analytics.ts. The matching negative (debit) rows on source wallets are
// deliberately ignored so this reads as "money that flowed into this
// organiser's events via carry-over".
export function summarizeCarryOverVolume(
  txs: { type: string; status: string; amountCents: number | null; currency: string }[]
): Record<string, number> {
  const byCurrency: Record<string, number> = {};
  for (const t of txs) {
    if (t.type !== "CARRY_OVER" || t.status !== "COMPLETED") continue;
    const cents = t.amountCents ?? 0;
    if (cents <= 0) continue; // credits only
    byCurrency[t.currency] = (byCurrency[t.currency] ?? 0) + cents;
  }
  return byCurrency;
}
