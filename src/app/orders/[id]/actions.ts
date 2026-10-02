"use server";

import { auth } from "@/auth";
import { setTicketGroupOptIn } from "@/lib/whatsapp-group";

export async function setOrderTicketGroupOptIn(ticketId: string, optedIn: boolean) {
  const session = await auth();
  if (!session?.user?.id) {
    throw new Error("Forbidden");
  }
  await setTicketGroupOptIn(session.user.id, ticketId, optedIn);
}
