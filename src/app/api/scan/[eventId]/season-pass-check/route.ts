import { NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { isSeasonPassHolderByCredential } from "@/lib/season-pass";

// The gate scanner's season-pass check, alongside its existing offline
// ticket-code check (see the "notProvisioned"/"wristbandReplaced" fallback
// in src/app/scan/[eventId]/page.tsx). Deliberately online-only: unlike a
// ticket check-in, which resolves entirely from the device's own synced
// Dexie cache, season pass holder data isn't synced down to devices at all
// (that would need a new offline table, a pull/route.ts payload field, and
// a Dexie version bump — out of scope alongside the rest of this session's
// foundation build). A device with no signal simply won't recognise a
// season-pass-only wristband until it's back online; an ordinary ticket
// wristband is unaffected either way.
const bodySchema = z.object({ nfcUid: z.string().min(1) });

export async function POST(request: Request, { params }: { params: { eventId: string } }) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ ok: false, reason: "UNAUTHENTICATED" }, { status: 401 });
  }

  const parsed = bodySchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ ok: false, reason: "INVALID_BODY" }, { status: 400 });
  }

  const credential = await prisma.credential.findFirst({
    where: { nfcUid: parsed.data.nfcUid, status: "ACTIVE" },
    select: { id: true },
  });
  if (!credential) {
    return NextResponse.json({ ok: true, holder: null });
  }

  const holder = await isSeasonPassHolderByCredential(credential.id, params.eventId);
  return NextResponse.json({ ok: true, holder });
}
