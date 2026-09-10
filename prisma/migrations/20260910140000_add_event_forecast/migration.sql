-- Session 10: pre-event revenue forecast inputs.

CREATE TABLE "EventForecast" (
    "id" TEXT NOT NULL,
    "expectedAttendance" INTEGER NOT NULL,
    "cashlessAdoptionRate" DOUBLE PRECISION NOT NULL,
    "avgSpendCents" INTEGER NOT NULL,
    "durationDays" INTEGER NOT NULL DEFAULT 1,
    "savedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "eventId" TEXT NOT NULL,
    "savedByUserId" TEXT NOT NULL,

    CONSTRAINT "EventForecast_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "EventForecast_eventId_key" ON "EventForecast"("eventId");

ALTER TABLE "EventForecast" ADD CONSTRAINT "EventForecast_eventId_fkey" FOREIGN KEY ("eventId") REFERENCES "Event"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "EventForecast" ADD CONSTRAINT "EventForecast_savedByUserId_fkey" FOREIGN KEY ("savedByUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
