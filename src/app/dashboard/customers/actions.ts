"use server";

import { revalidatePath } from "next/cache";
import { auth } from "@/auth";
import { addCustomerNoteById } from "@/lib/crm-handlers";
import { logAudit } from "@/lib/audit";
import { replaceTicketCode as replaceTicketCodeById, replaceWalletCode as replaceWalletCodeById } from "@/lib/credential-handlers";

// OWNER or STAFF, not GATE_CREW — matches this page's own view gate
// (routine day-to-day work, same as analytics/events, not a team-structure/
// irreversible action like team/audit/devices).
async function requireViewer() {
  const session = await auth();
  if (!session?.user?.id || session.user.organizationRole === "GATE_CREW") {
    throw new Error("Forbidden");
  }
  return session;
}

// Deliberately not audited — high-frequency CRM activity, same discipline
// that excludes device rename/check-ins from the audit log. The note
// timeline itself is the record.
export async function addNote(customerUserId: string, formData: FormData) {
  const session = await requireViewer();
  const body = formData.get("body");
  if (typeof body !== "string" || !body.trim()) {
    throw new Error("Note can't be empty.");
  }
  await addCustomerNoteById(
    session.user.organizationId,
    customerUserId,
    session.user.id,
    session.user.name ?? session.user.email ?? "Unknown",
    body.trim()
  );
  revalidatePath(`/dashboard/customers/${customerUserId}`);
}

export async function replaceTicketCode(ticketId: string) {
  const session = await requireViewer();
  const actorName = session.user.name ?? session.user.email ?? "Unknown";
  const ticket = await replaceTicketCodeById(session.user.organizationId, ticketId, session.user.id, actorName);
  await logAudit({
    organizationId: session.user.organizationId,
    actorUserId: session.user.id,
    actorName,
    action: "CREDENTIAL_REPLACED",
    summary: `Replaced ticket code for "${ticket.eventTitle}"`,
  });
  revalidatePath("/dashboard/customers/[userId]", "page");
}

export async function replaceWalletCode(walletId: string) {
  const session = await requireViewer();
  const actorName = session.user.name ?? session.user.email ?? "Unknown";
  const wallet = await replaceWalletCodeById(session.user.organizationId, walletId, session.user.id, actorName);
  await logAudit({
    organizationId: session.user.organizationId,
    actorUserId: session.user.id,
    actorName,
    action: "CREDENTIAL_REPLACED",
    summary: `Replaced wallet code for "${wallet.eventTitle}"`,
  });
  revalidatePath("/dashboard/customers/[userId]", "page");
}
