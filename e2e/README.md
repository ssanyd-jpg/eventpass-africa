# End-to-end tests (Playwright)

```bash
npm run test:e2e
```

Covers the 8 critical paths a bug in would cause immediate visible failure
at a live event: login, event creation, ticket purchase, gate check-in,
the vendor wallet-charge terminal, the vendor and sponsor magic-link
portals, and the public marathon leaderboard.

`playwright.config.ts` starts `next dev` automatically (`webServer`) and
runs everything against Chromium only.

## How fixtures work

`e2e/global-setup.ts` runs once before the suite and creates two dedicated
events directly via Prisma (not through the UI, for speed and determinism —
the same reasoning `prisma/seed.ts` and `src/lib/test-fixtures.ts` already
use): a general event with a paid ticket, an approved vendor with a
wallet-bearing buyer, and a sponsor; and a MARATHON event with a gun start
and one recorded finish, for the leaderboard. Both reuse the seeded
`organizer@chaap.dev` / `fan@chaap.dev` demo accounts (see
`prisma/seed.ts`) rather than creating fresh users. `e2e/global-teardown.ts`
deletes both events (and everything nested under them) afterward.
`event-create.spec.ts` and `ticket-purchase.spec.ts` create their own rows
through the UI at test time and delete them in an `afterEach`.

## Flagged tradeoffs (read before extending this suite)

- **Runs against the dev database (`DATABASE_URL`/`neondb`), not
  `TEST_DATABASE_URL`.** Vitest gets its own isolated Postgres database
  (see `DEPLOYMENT.md`); no equivalent exists yet for a `next dev` server,
  so these tests share the same database real local development uses.
  Every fixture row is per-run-unique and cleaned up (see above), but this
  is still worth fixing properly (a dedicated Neon branch + its own
  `.env.e2e`) before this suite runs in CI against shared infrastructure.
- **Real email/SMS is disabled for the spawned dev server only** —
  `playwright.config.ts`'s `webServer.env` blanks `RESEND_API_KEY`/
  `AT_API_KEY`/`AT_USERNAME` so `sendNotification()` (`src/lib/notifications.ts`)
  falls back to its safe `NotificationLog`-only path instead of sending real
  messages. This never touches `.env` itself, so `npm run dev` on its own is
  unaffected.
- **Vendor/sponsor magic-link tokens are minted directly via Prisma** in
  `global-setup.ts` (the same sha256-hashed-token scheme
  `generateVendorMagicLink`/`generateSponsorMagicLink` use), not scraped
  from a real email — there's no dev bypass endpoint for that login flow.
- **No "access zones" feature exists** in the app (verified — no matching
  field, model, or UI) and there's no draft/publish step for events
  (`Event.status` defaults to `"LIVE"`, and the create form's own submit
  action sets it explicitly) — `event-create.spec.ts` covers everything
  that actually exists instead of a literal reading of a spec written
  before this exploration happened.
- Camera/NFC scanning can't run under Playwright (no real camera or Web
  NFC in headless Chromium) — `gate-scan.spec.ts` and
  `vendor-terminal.spec.ts` only drive the manual code-entry form, per the
  original spec.
- **Neon's compute suspends after inactivity and can take 25-30s to wake up
  on the first query after a while** — confirmed by direct measurement
  against this project's own `DATABASE_URL` (a single `/api/sync/pull`
  request took 25-30s cold, under a second once warm). `playwright.config.ts`
  sets a 90s per-test timeout, and every assertion whose first render depends
  on a fresh pull uses a 30s+ (up to 75s for gate-scan/vendor-terminal's
  retry loops) explicit timeout to match — the same class of Neon-latency
  sensitivity this project's vitest suite has hit before. Running the suite
  again shortly after (compute still warm) is noticeably faster; a run after
  the database has been idle for a while is the slow case this is sized for.
- **Tests are serialized (`workers: 1`, `fullyParallel: false`), not just
  for the reason above** — concurrent workers each triggering their own
  NextAuth callback transaction against the same pooled connection produced
  "Unable to start a transaction in the given time" errors under the default
  parallelism.
