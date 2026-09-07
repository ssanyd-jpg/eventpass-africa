-- Offline outbox replay safety for Credential. Deliberately a plain index,
-- NOT unique, unlike every other outbox-created entity's clientId (Order,
-- Ticket, Wallet, WalletTransaction, Vendor, Sponsor, Event) — a single
-- provisioning op can create two Credential rows (wallet-linked +
-- ticket-linked) sharing the same clientId by design.
ALTER TABLE "Credential" ADD COLUMN "clientId" TEXT;
CREATE INDEX "Credential_clientId_idx" ON "Credential"("clientId");
