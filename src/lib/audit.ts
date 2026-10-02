import { prisma } from "@/lib/prisma";
import { formatCents } from "@/lib/format";

export type AuditAction =
  | "EVENT_CREATED"
  | "EVENT_EDITED"
  | "EVENT_CANCELLED"
  | "ORDER_REFUNDED"
  | "VENDOR_ADDED"
  | "VENDOR_APPROVED"
  | "VENDOR_REJECTED"
  | "SPONSOR_ADDED"
  | "SPONSOR_CAMPAIGN_ADDED"
  | "PAYOUT_ACCOUNT_ADDED"
  | "SETTLEMENT_RUN"
  | "MEMBER_INVITED"
  | "MEMBER_JOINED"
  | "MEMBER_REMOVED"
  | "DEVICE_REVOKED"
  | "DEVICE_REACTIVATED"
  | "BROADCAST_SENT"
  | "CREDENTIAL_REPLACED"
  | "CREDENTIAL_PROVISIONED"
  // Distinct from CREDENTIAL_REPLACED, which is the plain lost-code
  // reissue flow in credential-handlers.ts — this is specifically an NFC
  // wristband swap (see handleReplaceCredential), with a logged reason.
  | "WRISTBAND_REPLACED"
  | "ORDER_CANCELLED"
  | "ORDER_MARKED_PAID"
  | "WITHDRAWAL_APPROVED"
  | "WITHDRAWAL_REJECTED"
  | "VENDOR_PORTAL_LINK_SENT"
  | "SPONSOR_PORTAL_LINK_SENT"
  | "VENDOR_SETTLEMENT_PROCESSING"
  | "VENDOR_SETTLEMENT_PROCESSED"
  | "FLOAT_DECLARED"
  | "FORECAST_SAVED"
  | "TIMING_POINTS_SAVED"
  | "GUN_STARTED"
  | "CONFERENCE_SESSIONS_SAVED"
  | "WAITLIST_NOTIFIED"
  | "DENSITY_ALERT_RESOLVED"
  // Session 30
  | "VOLUNTEER_ADDED"
  | "VOLUNTEERS_IMPORTED"
  | "VOLUNTEER_INVITED"
  | "VOLUNTEER_STATUS_UPDATED"
  | "VOLUNTEER_CHECKED_IN"
  // Session 33
  | "LOYALTY_REWARD_CREATED"
  | "LOYALTY_REWARD_STATUS_CHANGED"
  // Session 39
  | "BRANDING_UPDATED"
  // Post-event WhatsApp memory recap
  | "POST_EVENT_MEMORY"
  // Season ticket / membership management — SEASON_PASS_PURCHASED and
  // SEASON_PASS_RENEWED get no buildSyncAuditEntry case below: both are
  // buyer/attendee self-actions (a purchase or a renewal payment), same
  // documented exclusion this file's own header comment already states for
  // WITHDRAW_WALLET. SEASON_PASS_RENEWAL_OFFERED is logged only from the
  // organiser's manual "Send renewal offers now" button — the cron sweep
  // has no real actorUserId to attribute it to.
  | "SEASON_PASS_PURCHASED"
  | "SEASON_PASS_RENEWAL_OFFERED"
  | "SEASON_PASS_RENEWED"
  // Chaap Ads marketplace — both are organiser self-actions with a real
  // actorUserId (an owner/staff member paying from the dashboard), logged
  // directly from src/app/dashboard/ads/actions.ts, same as
  // LOYALTY_REWARD_CREATED — not a buildSyncAuditEntry case, since neither
  // rides the offline sync queue.
  | "FEATURED_LISTING_PURCHASED"
  | "AD_BROADCAST_SENT"
  // PDPA self-service deletion (src/lib/account-deletion.ts) — logged
  // against the deleting user's own (personal) organization, the only one
  // every user is guaranteed to have.
  | "ACCOUNT_DELETED"
  // Event WhatsApp group (src/lib/whatsapp-group.ts) — logged once per
  // organiser-triggered batch action ("Send invites now" / "Send archive
  // message"), not once per individual attendee invite, same
  // one-entry-per-organiser-action granularity as BROADCAST_SENT.
  | "WHATSAPP_GROUP_INVITE_SENT"
  | "WHATSAPP_GROUP_ARCHIVED"
  // Final waitlist closure notifications (src/lib/waitlist.ts) are sent by
  // a cron sweep or straight from event cancellation, never from a real
  // actorUserId — no buildSyncAuditEntry case, same documented exclusion as
  // SEASON_PASS_PURCHASED/SEASON_PASS_RENEWED above. Listed here only so
  // the type exists if a future organiser-triggered trigger needs it.
  | "WAITLIST_CLOSURE";

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
    case "ADD_SPONSOR_CAMPAIGN":
      return { action: "SPONSOR_CAMPAIGN_ADDED", summary: `Added campaign "${result.campaign.name}"` };
    case "ADD_MOBILE_MONEY_ACCOUNT":
      return { action: "PAYOUT_ACCOUNT_ADDED", summary: `Linked a ${result.account.provider} payout account` };
    case "APPROVE_WITHDRAWAL":
      return { action: "WITHDRAWAL_APPROVED", summary: `Approved a withdrawal of ${formatCents(result.transaction.amountCents, result.transaction.currency)}` };
    case "REJECT_WITHDRAWAL":
      return { action: "WITHDRAWAL_REJECTED", summary: `Rejected a withdrawal of ${formatCents(result.transaction.amountCents, result.transaction.currency)}` };
    case "PROVISION_CREDENTIAL": {
      // Session 13: a group member has no user account to name — fall back
      // to the ticket's own groupMemberName (and its group) instead.
      const who = result.groupMemberName
        ? `${result.groupMemberName}${result.groupName ? ` (${result.groupName})` : ""}`
        : result.user?.name ?? "an attendee";
      return { action: "CREDENTIAL_PROVISIONED", summary: `Provisioned a wristband for ${who} at "${result.eventTitle}"` };
    }
    case "REPLACE_CREDENTIAL":
      return {
        action: "WRISTBAND_REPLACED",
        summary: `Replaced a wristband for ${result.wallet?.ownerName ?? "an attendee"} (reason: ${result.reason})`,
      };
    // CANCEL_PENDING_ORDER's own idempotent replay (order already resolved
    // some other way) also lands here since buildSyncAuditEntry only checks
    // result.ok — harmless duplicate-looking log entry, same tradeoff every
    // other idempotent op's audit case already accepts.
    case "CANCEL_PENDING_ORDER":
      return { action: "ORDER_CANCELLED", summary: `Cancelled a pending order for "${result.order.eventTitle}"` };
    case "MARK_ORDER_PAID":
      return { action: "ORDER_MARKED_PAID", summary: `Marked an order paid manually for "${result.order.eventTitle}"` };
    // WITHDRAW_WALLET itself gets no case — buyer self-action, matches the
    // "attendee/vendor-applicant self-actions excluded" convention this
    // model's own doc comment already states.
    default:
      return null;
  }
}
