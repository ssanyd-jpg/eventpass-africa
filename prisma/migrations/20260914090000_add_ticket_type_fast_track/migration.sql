-- Session 14: VIP fast-track visual signal at the gate scanner.
ALTER TABLE "TicketType" ADD COLUMN "isFastTrack" BOOLEAN NOT NULL DEFAULT false;
