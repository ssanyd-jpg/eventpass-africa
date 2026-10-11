import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { expirePoolsOpportunistically } from "@/lib/ticket-pool";
import { firstNameOf } from "@/lib/wallet-transfer";

// GET: public lookup by pool id, same threat model as a ticket-transfer
// link (src/app/api/tickets/transfer/[id]/route.ts) — anyone with the
// shared link can see enough to decide whether to contribute, before
// signing in or signing up. Never exposes contributors' identities or
// individual contribution amounts, only the running total.
export async function GET(_request: Request, { params }: { params: { id: string } }) {
  await expirePoolsOpportunistically();

  const pool = await prisma.ticketPool.findUnique({
    where: { id: params.id },
    include: {
      event: { select: { title: true, slug: true } },
      ticketType: { select: { name: true } },
      recipient: { select: { name: true } },
      creator: { select: { name: true } },
    },
  });
  if (!pool) {
    return NextResponse.json({ ok: false, error: "This pool link is invalid." }, { status: 404 });
  }

  return NextResponse.json({
    ok: true,
    pool: {
      id: pool.id,
      name: pool.name,
      status: pool.status,
      targetCents: pool.targetCents,
      raisedCents: pool.raisedCents,
      currency: pool.currency,
      quantity: pool.quantity,
      expiresAt: pool.expiresAt.toISOString(),
      eventTitle: pool.event.title,
      eventSlug: pool.event.slug,
      ticketTypeName: pool.ticketType.name,
      recipientFirstName: firstNameOf(pool.recipient.name),
      creatorFirstName: firstNameOf(pool.creator.name),
    },
  });
}
