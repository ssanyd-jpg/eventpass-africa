-- Session 26 — waitlist for sold-out ticket tiers. Organiser opts in per
-- event (Event.waitlistEnabled); WaitlistEntry queues guests/attendees per
-- (eventId, ticketTypeId) FIFO by position. Purely additive — no data
-- change to any existing table besides the new nullable-default column on
-- Event.

ALTER TABLE "Event" ADD COLUMN "waitlistEnabled" BOOLEAN NOT NULL DEFAULT false;

CREATE TABLE "WaitlistEntry" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "phone" TEXT NOT NULL,
    "email" TEXT,
    "position" INTEGER NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'WAITING',
    "notifiedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "eventId" TEXT NOT NULL,
    "ticketTypeId" TEXT NOT NULL,
    "userId" TEXT,

    CONSTRAINT "WaitlistEntry_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "WaitlistEntry_ticketTypeId_status_position_idx" ON "WaitlistEntry"("ticketTypeId", "status", "position");
CREATE INDEX "WaitlistEntry_eventId_idx" ON "WaitlistEntry"("eventId");

ALTER TABLE "WaitlistEntry" ADD CONSTRAINT "WaitlistEntry_eventId_fkey" FOREIGN KEY ("eventId") REFERENCES "Event"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "WaitlistEntry" ADD CONSTRAINT "WaitlistEntry_ticketTypeId_fkey" FOREIGN KEY ("ticketTypeId") REFERENCES "TicketType"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "WaitlistEntry" ADD CONSTRAINT "WaitlistEntry_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
