-- On-demand AI categorization/priority for support tickets (organizer
-- clicks "Suggest" — not computed automatically on ticket creation).
-- Nullable: a null value means "not yet suggested," not "no category
-- applies."
ALTER TABLE "SupportTicket" ADD COLUMN "aiCategory" TEXT;
ALTER TABLE "SupportTicket" ADD COLUMN "aiPriority" TEXT;
