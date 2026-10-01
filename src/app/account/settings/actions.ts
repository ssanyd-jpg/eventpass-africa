"use server";

import { auth } from "@/auth";
import { deleteOwnAccount } from "@/lib/account-deletion";

async function requireSelf() {
  const session = await auth();
  if (!session?.user?.id) {
    throw new Error("Forbidden");
  }
  return session;
}

// Thrown Errors (the safety-gate block, or "Account not found") propagate to
// the client component's try/catch around this call — same direct-call
// pattern as /account/sessions, just invoked from an onClick instead of a
// <form action> so the message can be shown inline instead of hitting an
// error boundary.
export async function deleteAccount() {
  const session = await requireSelf();
  await deleteOwnAccount(session.user.id);
}
