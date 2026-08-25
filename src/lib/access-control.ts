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
  "TOPUP_WALLET",
  "CHECK_TOPUP_STATUS",
]);

export function isOpAllowedForRole(organizationRole: string | undefined, opType: OpType): boolean {
  if (organizationRole !== "GATE_CREW") return true;
  return GATE_CREW_ALLOWED_OPS.has(opType);
}
