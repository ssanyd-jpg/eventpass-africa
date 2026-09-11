-- Session 12: marathon chip timing + live leaderboard.

ALTER TABLE "Event" ADD COLUMN "eventType" TEXT NOT NULL DEFAULT 'GENERAL';
ALTER TABLE "Event" ADD COLUMN "gunStartAt" TIMESTAMP(3);

CREATE TABLE "TimingPoint" (
    "id" TEXT NOT NULL,
    "clientId" TEXT,
    "name" TEXT NOT NULL,
    "location" TEXT NOT NULL DEFAULT '',
    "sequenceOrder" INTEGER NOT NULL,
    "isStart" BOOLEAN NOT NULL DEFAULT false,
    "isFinish" BOOLEAN NOT NULL DEFAULT false,
    "distanceMeters" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "eventId" TEXT NOT NULL,

    CONSTRAINT "TimingPoint_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "TimingPoint_clientId_key" ON "TimingPoint"("clientId");
CREATE INDEX "TimingPoint_eventId_sequenceOrder_idx" ON "TimingPoint"("eventId", "sequenceOrder");

ALTER TABLE "TimingPoint" ADD CONSTRAINT "TimingPoint_eventId_fkey" FOREIGN KEY ("eventId") REFERENCES "Event"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "ChipTime" (
    "id" TEXT NOT NULL,
    "clientId" TEXT,
    "recordedAt" TIMESTAMP(3) NOT NULL,
    "gunTimeOffsetSeconds" INTEGER,
    "splitTimeSeconds" INTEGER,
    "syncedAt" TIMESTAMP(3),
    "eventId" TEXT NOT NULL,
    "timingPointId" TEXT NOT NULL,
    "credentialId" TEXT NOT NULL,

    CONSTRAINT "ChipTime_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "ChipTime_clientId_key" ON "ChipTime"("clientId");
CREATE UNIQUE INDEX "ChipTime_credentialId_timingPointId_key" ON "ChipTime"("credentialId", "timingPointId");
CREATE INDEX "ChipTime_eventId_timingPointId_idx" ON "ChipTime"("eventId", "timingPointId");

ALTER TABLE "ChipTime" ADD CONSTRAINT "ChipTime_eventId_fkey" FOREIGN KEY ("eventId") REFERENCES "Event"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ChipTime" ADD CONSTRAINT "ChipTime_timingPointId_fkey" FOREIGN KEY ("timingPointId") REFERENCES "TimingPoint"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ChipTime" ADD CONSTRAINT "ChipTime_credentialId_fkey" FOREIGN KEY ("credentialId") REFERENCES "Credential"("id") ON DELETE CASCADE ON UPDATE CASCADE;
