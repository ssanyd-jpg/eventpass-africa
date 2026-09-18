-- Session 27 — dynamic pricing for sold-out-risk ticket tiers.
-- TicketType.pricingStrategy is FIXED (existing behaviour, priceCents as-is)
-- or TIERED (price steps up as PricingTier thresholds are crossed). Purely
-- additive — no data change to any existing row besides the new
-- not-null-with-default column on TicketType.

ALTER TABLE "TicketType" ADD COLUMN "pricingStrategy" TEXT NOT NULL DEFAULT 'FIXED';

CREATE TABLE "PricingTier" (
    "id" TEXT NOT NULL,
    "clientId" TEXT,
    "label" TEXT,
    "fromQuantity" INTEGER NOT NULL,
    "priceCents" INTEGER NOT NULL,
    "ticketTypeId" TEXT NOT NULL,

    CONSTRAINT "PricingTier_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "PricingTier_clientId_key" ON "PricingTier"("clientId");
CREATE UNIQUE INDEX "PricingTier_ticketTypeId_fromQuantity_key" ON "PricingTier"("ticketTypeId", "fromQuantity");
CREATE INDEX "PricingTier_ticketTypeId_idx" ON "PricingTier"("ticketTypeId");

ALTER TABLE "PricingTier" ADD CONSTRAINT "PricingTier_ticketTypeId_fkey" FOREIGN KEY ("ticketTypeId") REFERENCES "TicketType"("id") ON DELETE CASCADE ON UPDATE CASCADE;
