-- AlterTable
ALTER TABLE "Event" ADD COLUMN     "whatsappGroupArchivedAt" TIMESTAMP(3),
ADD COLUMN     "whatsappGroupEnabled" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "whatsappGroupLink" TEXT,
ADD COLUMN     "whatsappGroupLinkRevokedAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "Ticket" ADD COLUMN     "whatsappGroupInviteSentAt" TIMESTAMP(3),
ADD COLUMN     "whatsappGroupOptedIn" BOOLEAN NOT NULL DEFAULT false;
