"use server";

import { auth } from "@/auth";
import { joinGroup, leaveGroup } from "@/lib/whatsapp-group";

async function requireSelf() {
  const session = await auth();
  if (!session?.user?.id) {
    throw new Error("Forbidden");
  }
  return session;
}

export async function joinWhatsappGroup(ticketId: string) {
  const session = await requireSelf();
  return joinGroup(session.user.id, ticketId);
}

export async function leaveWhatsappGroup(ticketId: string) {
  const session = await requireSelf();
  await leaveGroup(session.user.id, ticketId);
}
