import { NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/auth";
import { createTransfer, listPendingTransfersForTickets } from "@/lib/ticket-transfer";

const transferSchema = z.object({
  ticketId: z.string().min(1),
  toEmail: z.string().email(),
});

// GET: pending transfers the caller has SENT for a given set of tickets —
// powers the "Cancel" affordance on OrderConfirmation. Filtered to the
// caller's own sends only; not a general lookup.
export async function GET(request: Request) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ ok: false, error: "Sign in required." }, { status: 401 });
  }
  const ticketIds = (new URL(request.url).searchParams.get("ticketIds") ?? "").split(",").filter(Boolean);
  const transfers = await listPendingTransfersForTickets(ticketIds);
  return NextResponse.json({
    ok: true,
    transfers: transfers.filter((t) => t.fromUserId === session.user.id),
  });
}

// Deliberately a plain authenticated route, not a queueOp/handle*/sync
// mutation — see the "Governing conventions" note in the plan. Transferring
// a ticket has no legitimate offline use case (it's an inherently online,
// social action, unlike selling a ticket at a poorly-connected gate) and
// needs to synchronously report success/failure rather than silently queue.
export async function POST(request: Request) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ ok: false, error: "Sign in to transfer a ticket." }, { status: 401 });
  }

  const parsed = transferSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ ok: false, error: "Enter a valid email." }, { status: 400 });
  }

  const result = await createTransfer(session.user.id, parsed.data.ticketId, parsed.data.toEmail);
  if (!result.ok) {
    return NextResponse.json(result, { status: 400 });
  }
  return NextResponse.json(result);
}
