import { prisma } from "@/lib/prisma";

export type AuditAction =
  | "EVENT_CREATED"
  | "EVENT_EDITED"
  | "EVENT_CANCELLED"
  | "ORDER_REFUNDED"
  | "VENDOR_ADDED"
  | "VENDOR_APPROVED"
  | "VENDOR_REJECTED"
  | "SPONSOR_ADDED"
  | "PAYOUT_ACCOUNT_ADDED"
  | "SETTLEMENT_RUN"
  | "MEMBER_INVITED"
  | "MEMBER_JOINED"
  | "MEMBER_REMOVED";

interface LogAuditInput {
  organizationId: string;
  actorUserId: string;
  actorName: string;
  action: AuditAction;
  summary: string;
}

// Single choke point every organization-level accountability event goes
// through — mirrors sendNotification()'s shape and placement discipline
// (src/lib/notifications.ts): called after the mutation/transaction it
// describes has already committed, never inside it.
export async function logAudit(input: LogAuditInput) {
  return prisma.auditLog.create({ data: input });
}

// Maps a successful sync/push result to an audit entry, or null for
// non-audited ops (personal/attendee/gate-scan) or a call that didn't
// actually succeed.
export function buildSyncAuditEntry(
  opType: string,
  result: any
): { action: AuditAction; summary: string } | null {
  if (!result?.ok) return null;
  switch (opType) {
    case "CREATE_EVENT":
      return { action: "EVENT_CREATED", summary: `Created "${result.event.title}"` };
    case "EDIT_EVENT":
      return { action: "EVENT_EDITED", summary: `Edited "${result.event.title}"` };
    case "CANCEL_EVENT":
      return { action: "EVENT_CANCELLED", summary: `Cancelled "${result.event.title}"` };
    case "REFUND_ORDER":
      return { action: "ORDER_REFUNDED", summary: `Refunded an order for "${result.order.eventTitle}"` };
    case "ADD_VENDOR":
      return { action: "VENDOR_ADDED", summary: `Added vendor "${result.vendor.name}"` };
    case "APPROVE_VENDOR":
      return { action: "VENDOR_APPROVED", summary: `Approved vendor "${result.vendor.name}"` };
    case "REJECT_VENDOR":
      return { action: "VENDOR_REJECTED", summary: `Rejected vendor "${result.vendor.name}"` };
    case "ADD_SPONSOR":
      return { action: "SPONSOR_ADDED", summary: `Added sponsor "${result.sponsor.name}"` };
    case "ADD_MOBILE_MONEY_ACCOUNT":
      return { action: "PAYOUT_ACCOUNT_ADDED", summary: `Linked a ${result.account.provider} payout account` };
    default:
      return null;
  }
}
