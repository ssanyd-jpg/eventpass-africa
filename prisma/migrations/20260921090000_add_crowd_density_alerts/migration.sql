-- Session 29 — real-time crowd-density safety alerts. TicketType is the
-- codebase's existing closest concept to a physical "zone" (see the schema
-- comment on TicketType.physicalCapacity), so this is purely additive —
-- no data change to any existing row besides the new nullable column.

ALTER TABLE "TicketType" ADD COLUMN "physicalCapacity" INTEGER;

CREATE TABLE "DensityAlert" (
    "id" TEXT NOT NULL,
    "zoneName" TEXT NOT NULL,
    "alertType" TEXT NOT NULL,
    "triggeredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolvedAt" TIMESTAMP(3),
    "resolvedBy" TEXT,
    "resolutionNote" TEXT,
    "message" TEXT NOT NULL,
    "eventId" TEXT NOT NULL,

    CONSTRAINT "DensityAlert_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "DensityAlert_eventId_resolvedAt_idx" ON "DensityAlert"("eventId", "resolvedAt");

ALTER TABLE "DensityAlert" ADD CONSTRAINT "DensityAlert_eventId_fkey" FOREIGN KEY ("eventId") REFERENCES "Event"("id") ON DELETE CASCADE ON UPDATE CASCADE;
