-- NFC wristband provisioning: link a tag's hardware UID to a Credential row.
-- Deliberately no unique constraint on nfcUid — the same physical tag
-- legitimately produces two ACTIVE rows at once (one ticket-linked, one
-- wallet-linked); uniqueness-per-entity is enforced application-side, same
-- as the existing `code` column already has no DB uniqueness.
ALTER TABLE "Credential" ADD COLUMN "nfcUid" TEXT;
CREATE INDEX "Credential_organizationId_nfcUid_idx" ON "Credential"("organizationId", "nfcUid");
