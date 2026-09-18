-- Session 30 — volunteer and crew management. Purely additive: a new
-- Volunteer table plus a nullable volunteerId column on Credential so a
-- volunteer's wristband resolves at scan time the same way a ticket, wallet,
-- or vendor credential does.

CREATE TABLE "Volunteer" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "phone" TEXT NOT NULL,
    "email" TEXT,
    "role" TEXT NOT NULL,
    "shiftStart" TIMESTAMP(3) NOT NULL,
    "shiftEnd" TIMESTAMP(3) NOT NULL,
    "zoneAccess" TEXT NOT NULL DEFAULT '',
    "status" TEXT NOT NULL DEFAULT 'INVITED',
    "wristbandCredentialId" TEXT,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "eventId" TEXT NOT NULL,

    CONSTRAINT "Volunteer_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "Volunteer_eventId_status_idx" ON "Volunteer"("eventId", "status");
CREATE INDEX "Volunteer_eventId_phone_idx" ON "Volunteer"("eventId", "phone");

ALTER TABLE "Volunteer" ADD CONSTRAINT "Volunteer_eventId_fkey" FOREIGN KEY ("eventId") REFERENCES "Event"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "Credential" ADD COLUMN "volunteerId" TEXT;

CREATE INDEX "Credential_organizationId_volunteerId_idx" ON "Credential"("organizationId", "volunteerId");

ALTER TABLE "Credential" ADD CONSTRAINT "Credential_volunteerId_fkey" FOREIGN KEY ("volunteerId") REFERENCES "Volunteer"("id") ON DELETE CASCADE ON UPDATE CASCADE;
