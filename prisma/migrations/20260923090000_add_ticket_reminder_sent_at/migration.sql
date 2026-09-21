-- Once-daily reminder cron — records when a ticket's pre-event reminder was
-- sent so a wide lookahead window can't remind the same buyer twice.
-- Purely additive: a nullable column, no backfill needed (null = not
-- reminded yet; the NotificationLog check in sendEventReminders still
-- covers reminders sent before this column existed).

ALTER TABLE "Ticket" ADD COLUMN "reminderSentAt" TIMESTAMP(3);
