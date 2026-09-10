"use server";

import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { logAudit } from "@/lib/audit";
import { formatCents } from "@/lib/format";
import { saveFloatDeclarationCore } from "@/lib/reconciliation";

// OWNER or STAFF, not GATE_CREW — same rule as the reconciliation page and
// the analytics export route (this is routine reconciliation work STAFF
// already do, not a money-moving action gated to OWNER).
async function requireViewer() {
  const session = await auth();
  if (!session?.user?.id || session.user.organizationRole === "GATE_CREW") {
    throw new Error("Forbidden");
  }
  return session;
}

export async function saveFloatDeclaration(input: {
  eventId: string;
  operatorId: string;
  declaredAmountCents: number;
}) {
  const session = await requireViewer();
  const actorName = session.user.name ?? session.user.email ?? "Unknown";

  const event = await prisma.event.findUnique({
    where: { id: input.eventId },
    select: { organizationId: true, currency: true },
  });
  if (!event || event.organizationId !== session.user.organizationId) {
    throw new Error("Forbidden");
  }
  if (!Number.isInteger(input.declaredAmountCents) || input.declaredAmountCents < 0) {
    throw new Error("Declared amount must be a non-negative whole number of cents.");
  }
  // The operator must actually have cash orders on this event — guards
  // against a crafted request declaring a float for an unrelated user.
  const operatorOrderCount = await prisma.order.count({
    where: {
      eventId: input.eventId,
      userId: input.operatorId,
      status: { in: ["PAID", "NEEDS_REVIEW"] },
      paymentMethod: "OFFLINE_DEFERRED",
    },
  });
  if (operatorOrderCount === 0) {
    throw new Error("That operator has no cash orders on this event.");
  }

  const result = await saveFloatDeclarationCore({
    eventId: input.eventId,
    operatorId: input.operatorId,
    declaredAmountCents: input.declaredAmountCents,
    declaredByUserId: session.user.id,
  });

  await logAudit({
    organizationId: session.user.organizationId,
    actorUserId: session.user.id,
    actorName,
    action: "FLOAT_DECLARED",
    summary: `Declared cash float of ${formatCents(input.declaredAmountCents, event.currency)} — variance ${formatCents(
      result.varianceCents,
      event.currency
    )} (${result.status})`,
  });

  return result;
}
