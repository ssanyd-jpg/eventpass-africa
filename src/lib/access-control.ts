import type { payloadSchemas } from "@/lib/sync-handlers";

type OpType = keyof typeof payloadSchemas;

// GATE_CREW is minimal event-day door staff — allowed to check tickets and
// vendor badges in at the gate, plus the personal/self-scoped ops every
// user keeps regardless of organizationRole (buying tickets, applying to
// vendor, their own wallet). Deny-by-default: any op not listed here is
// blocked for GATE_CREW, including any OutboxOpType added later — a new op
// must be deliberately added below to become available to gate crew.
const GATE_CREW_ALLOWED_OPS: ReadonlySet<OpType> = new Set<OpType>([
  "CHECK_IN",
  "CHECK_IN_VENDOR",
  "SELL_TICKETS",
  "APPLY_VENDOR",
  "CREATE_WALLET",
  // Buyer self-action, same as CREATE_WALLET — registering a wallet at a
  // new event, just carrying a prior balance into it (Session 11).
  "CARRY_OVER_WALLET",
  "TOPUP_WALLET",
  "CHECK_TOPUP_STATUS",
  "WITHDRAW_WALLET",
  "CHECK_ORDER_PAYMENT_STATUS",
  // Buyer self-action, same as CHECK_ORDER_PAYMENT_STATUS above — a gate
  // crew member is still a buyer for their own orders. MARK_ORDER_PAID is
  // deliberately NOT here: that's an organizer reconciliation action.
  "CANCEL_PENDING_ORDER",
]);

export function isOpAllowedForRole(organizationRole: string | undefined, opType: OpType): boolean {
  if (organizationRole !== "GATE_CREW") return true;
  return GATE_CREW_ALLOWED_OPS.has(opType);
}
