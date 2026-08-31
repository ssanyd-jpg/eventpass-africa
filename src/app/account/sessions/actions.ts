"use server";

import { revalidatePath } from "next/cache";
import { auth } from "@/auth";
import { revokeUserSessionById, revokeAllOtherUserSessions } from "@/lib/session-handlers";

async function requireSelf() {
  const session = await auth();
  if (!session?.user?.id) {
    throw new Error("Forbidden");
  }
  return session;
}

export async function revokeSession(sessionRowId: string) {
  const session = await requireSelf();
  // Server-side backstop against a stale/replayed form post — the UI
  // already omits the Revoke button on the current-session row entirely.
  if (sessionRowId === session.sessionId) {
    throw new Error("Cannot revoke your current session this way — sign out instead.");
  }
  await revokeUserSessionById(session.user.id, sessionRowId, session.user.id);
  revalidatePath("/account/sessions");
}

export async function revokeOtherSessions() {
  const session = await requireSelf();
  if (!session.sessionId) {
    throw new Error("Forbidden");
  }
  await revokeAllOtherUserSessions(session.user.id, session.sessionId);
  revalidatePath("/account/sessions");
}
