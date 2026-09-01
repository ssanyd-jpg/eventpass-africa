"use server";

import { revalidatePath } from "next/cache";
import { auth } from "@/auth";
import { replyToSupportTicketAsOrganizer, resolveSupportTicket } from "@/lib/support-handlers";

// OWNER or STAFF, not GATE_CREW — matches dashboard/customers/actions.ts's
// requireViewer() exactly (routine day-to-day work, not a team-structure/
// irreversible action).
async function requireViewer() {
  const session = await auth();
  if (!session?.user?.id || session.user.organizationRole === "GATE_CREW") {
    throw new Error("Forbidden");
  }
  return session;
}

export async function replyAsOrganizer(ticketId: string, formData: FormData) {
  const session = await requireViewer();
  const body = formData.get("body");
  if (typeof body !== "string" || !body.trim()) {
    throw new Error("Message can't be empty.");
  }
  await replyToSupportTicketAsOrganizer(
    session.user.organizationId,
    ticketId,
    session.user.id,
    session.user.name ?? session.user.email ?? "Unknown",
    body
  );
  revalidatePath(`/dashboard/support/${ticketId}`);
}

export async function markResolved(ticketId: string) {
  const session = await requireViewer();
  await resolveSupportTicket(session.user.organizationId, ticketId);
  revalidatePath(`/dashboard/support/${ticketId}`);
  revalidatePath("/dashboard/support");
}
