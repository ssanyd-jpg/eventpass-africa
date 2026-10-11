"use server";

import { z } from "zod";
import { randomUUID } from "crypto";
import { revalidatePath } from "next/cache";
import { auth } from "@/auth";
import { startPool as startPoolCore, cancelPool as cancelPoolCore } from "@/lib/ticket-pool";

async function requireSelf() {
  const session = await auth();
  if (!session?.user?.id) {
    throw new Error("Forbidden");
  }
  return session;
}

const startPoolSchema = z.object({
  ticketTypeId: z.string().min(1),
  quantity: z.number().int().min(1).max(20).optional(),
  name: z.string().trim().max(80).optional(),
  // Days from now, not a raw Date — keeps the client form a plain number
  // input rather than a date picker, same "simple input, server computes
  // the real timestamp" tradeoff as changePassword's min-length check.
  expiresInDays: z.number().int().min(1).max(90),
});

// Self-pooling only in this UI (creator === recipient) — pooling toward
// someone else's ticket is supported in ticket-pool.ts but not exposed
// here in v1; see this file's own scope note in the plan.
export async function startPool(input: { ticketTypeId: string; quantity?: number; name?: string; expiresInDays: number }) {
  const session = await requireSelf();
  const parsed = startPoolSchema.safeParse(input);
  if (!parsed.success) {
    throw new Error(parsed.error.issues[0]?.message ?? "Invalid input");
  }

  const result = await startPoolCore({
    clientId: randomUUID(),
    ticketTypeId: parsed.data.ticketTypeId,
    creatorUserId: session.user.id,
    recipientUserId: session.user.id,
    quantity: parsed.data.quantity,
    name: parsed.data.name,
    expiresAt: new Date(Date.now() + parsed.data.expiresInDays * 24 * 60 * 60 * 1000),
  });
  if (!result.ok) {
    throw new Error(result.reason);
  }
  revalidatePath("/account/pools");
  return { id: result.pool.id };
}

export async function cancelPool(poolId: string) {
  const session = await requireSelf();
  const result = await cancelPoolCore(poolId, session.user.id);
  if (!result.ok) {
    throw new Error(result.reason);
  }
  revalidatePath("/account/pools");
}
