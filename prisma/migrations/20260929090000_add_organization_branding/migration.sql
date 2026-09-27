-- Session 39 — Case A organiser branding (own-brand attendee experience).
-- Purely additive: three nullable columns on Organization, no default
-- needed since null already means "use Chaap's default branding"
-- everywhere they're read. Existing rows and code paths are untouched.

ALTER TABLE "Organization" ADD COLUMN "displayName" TEXT;
ALTER TABLE "Organization" ADD COLUMN "logoUrl" TEXT;
ALTER TABLE "Organization" ADD COLUMN "brandColor" TEXT;
