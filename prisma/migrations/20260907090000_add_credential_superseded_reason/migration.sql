-- Wristband replacement flow: why a Credential was superseded
-- (LOST/DAMAGED/STOLEN). Note: supersededAt already exists on this model
-- (added for the original provisioning feature) — this migration only adds
-- the new reason column.
ALTER TABLE "Credential" ADD COLUMN "supersededReason" TEXT;
