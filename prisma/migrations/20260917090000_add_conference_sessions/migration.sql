-- Session 19: CONFERENCE session management + attendance scanning +
-- exhibitor lead capture.

-- ConferenceSession
CREATE TABLE "ConferenceSession" (
    "id" TEXT NOT NULL,
    "clientId" TEXT,
    "name" TEXT NOT NULL,
    "speaker" TEXT,
    "location" TEXT,
    "startsAt" TIMESTAMP(3) NOT NULL,
    "endsAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "eventId" TEXT NOT NULL,

    CONSTRAINT "ConferenceSession_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "ConferenceSession_clientId_key" ON "ConferenceSession"("clientId");
CREATE INDEX "ConferenceSession_eventId_startsAt_idx" ON "ConferenceSession"("eventId", "startsAt");

ALTER TABLE "ConferenceSession" ADD CONSTRAINT "ConferenceSession_eventId_fkey"
    FOREIGN KEY ("eventId") REFERENCES "Event"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- SessionAttendance
CREATE TABLE "SessionAttendance" (
    "id" TEXT NOT NULL,
    "clientId" TEXT,
    "recordedAt" TIMESTAMP(3) NOT NULL,
    "syncedAt" TIMESTAMP(3),
    "eventId" TEXT NOT NULL,
    "eventSessionId" TEXT NOT NULL,
    "credentialId" TEXT NOT NULL,

    CONSTRAINT "SessionAttendance_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "SessionAttendance_clientId_key" ON "SessionAttendance"("clientId");
CREATE UNIQUE INDEX "SessionAttendance_credentialId_eventSessionId_key" ON "SessionAttendance"("credentialId", "eventSessionId");
CREATE INDEX "SessionAttendance_eventId_eventSessionId_idx" ON "SessionAttendance"("eventId", "eventSessionId");

ALTER TABLE "SessionAttendance" ADD CONSTRAINT "SessionAttendance_eventId_fkey"
    FOREIGN KEY ("eventId") REFERENCES "Event"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "SessionAttendance" ADD CONSTRAINT "SessionAttendance_eventSessionId_fkey"
    FOREIGN KEY ("eventSessionId") REFERENCES "ConferenceSession"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "SessionAttendance" ADD CONSTRAINT "SessionAttendance_credentialId_fkey"
    FOREIGN KEY ("credentialId") REFERENCES "Credential"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ExhibitorLead
CREATE TABLE "ExhibitorLead" (
    "id" TEXT NOT NULL,
    "clientId" TEXT,
    "notes" TEXT,
    "capturedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "eventId" TEXT NOT NULL,
    "vendorId" TEXT NOT NULL,
    "credentialId" TEXT NOT NULL,

    CONSTRAINT "ExhibitorLead_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "ExhibitorLead_clientId_key" ON "ExhibitorLead"("clientId");
CREATE INDEX "ExhibitorLead_eventId_vendorId_idx" ON "ExhibitorLead"("eventId", "vendorId");
CREATE INDEX "ExhibitorLead_vendorId_capturedAt_idx" ON "ExhibitorLead"("vendorId", "capturedAt");

ALTER TABLE "ExhibitorLead" ADD CONSTRAINT "ExhibitorLead_eventId_fkey"
    FOREIGN KEY ("eventId") REFERENCES "Event"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ExhibitorLead" ADD CONSTRAINT "ExhibitorLead_vendorId_fkey"
    FOREIGN KEY ("vendorId") REFERENCES "Vendor"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ExhibitorLead" ADD CONSTRAINT "ExhibitorLead_credentialId_fkey"
    FOREIGN KEY ("credentialId") REFERENCES "Credential"("id") ON DELETE CASCADE ON UPDATE CASCADE;
