-- Session 25 — public event discovery marketplace. getPublicEvents and
-- getFeaturedEvents (src/lib/marketplace.ts) filter every request by
-- status = 'LIVE' AND startsAt >= now, sorted by startsAt — Event had no
-- index beyond its id/clientId/slug uniques before this, so both the
-- public /events listing and the homepage's featured-events query forced
-- a full table scan. Purely additive — no data change, no application
-- behavior change.
CREATE INDEX "Event_status_startsAt_idx" ON "Event"("status", "startsAt");
