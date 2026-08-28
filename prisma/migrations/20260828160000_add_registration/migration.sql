-- Registration: organizer-defined custom checkout questions + optional
-- waiver. Purely additive, no backfill needed — no event has questions or a
-- waiver today.

ALTER TABLE "Event" ADD COLUMN "waiverText" TEXT;
ALTER TABLE "Order" ADD COLUMN "waiverText" TEXT;
ALTER TABLE "Order" ADD COLUMN "waiverAcceptedAt" TIMESTAMP(3);

CREATE TABLE "RegistrationQuestion" (
    "id" TEXT NOT NULL,
    "clientId" TEXT,
    "label" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "options" TEXT,
    "required" BOOLEAN NOT NULL DEFAULT false,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "eventId" TEXT NOT NULL,

    CONSTRAINT "RegistrationQuestion_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "RegistrationQuestion_clientId_key" ON "RegistrationQuestion"("clientId");

ALTER TABLE "RegistrationQuestion" ADD CONSTRAINT "RegistrationQuestion_eventId_fkey" FOREIGN KEY ("eventId") REFERENCES "Event"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "RegistrationAnswer" (
    "id" TEXT NOT NULL,
    "value" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "orderId" TEXT NOT NULL,
    "questionId" TEXT NOT NULL,

    CONSTRAINT "RegistrationAnswer_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "RegistrationAnswer_orderId_idx" ON "RegistrationAnswer"("orderId");

ALTER TABLE "RegistrationAnswer" ADD CONSTRAINT "RegistrationAnswer_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "RegistrationAnswer" ADD CONSTRAINT "RegistrationAnswer_questionId_fkey" FOREIGN KEY ("questionId") REFERENCES "RegistrationQuestion"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
