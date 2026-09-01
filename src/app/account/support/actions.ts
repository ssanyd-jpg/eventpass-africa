"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { auth } from "@/auth";
import { createSupportTicket, replyToSupportTicketAsBuyer } from "@/lib/support-handlers";

async function requireSelf() {
  const session = await auth();
  if (!session?.user?.id) {
    throw new Error("Forbidden");
  }
  return session;
}

export async function createTicket(eventId: string, formData: FormData) {
  const session = await requireSelf();
  const subject = formData.get("subject");
  const body = formData.get("body");
  if (typeof subject !== "string" || !subject.trim() || typeof body !== "string" || !body.trim()) {
    throw new Error("Subject and message are required.");
  }
  const result = await createSupportTicket(session.user.id, eventId, subject, body);
  if (!result.ok) {
    throw new Error(result.error);
  }
  redirect(`/account/support/${result.ticketId}`);
}

export async function replyAsBuyer(ticketId: string, formData: FormData) {
  const session = await requireSelf();
  const body = formData.get("body");
  if (typeof body !== "string" || !body.trim()) {
    throw new Error("Message can't be empty.");
  }
  await replyToSupportTicketAsBuyer(
    session.user.id,
    ticketId,
    session.user.name ?? session.user.email ?? "Unknown",
    body
  );
  revalidatePath(`/account/support/${ticketId}`);
}
