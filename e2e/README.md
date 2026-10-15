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

## Database setup (one-time, per `.env.e2e` branch)

Unlike `TEST_DATABASE_URL` (dropped to a bare schema and rebuilt on every
`npm test` run), the database `.env.e2e` points at is expected to stay
**persistently migrated and seeded** — `global-setup.ts` does
`findUniqueOrThrow` on the `organizer@chaap.dev`/`fan@chaap.dev` demo
accounts from `prisma/seed.ts`, the same way a real dev database already
has them. A Neon branch also isn't free to tear down and recreate every
run the way the vitest job's disposable Postgres container is. So after
creating the branch (Neon dashboard → Branches → create from main) and
pointing `.env.e2e` at it (see `.env.example`), run once:

```bash
node --env-file=.env.e2e node_modules/.bin/prisma db push --accept-data-loss
node --env-file=.env.e2e node_modules/.bin/prisma db seed
```

`db push`, not `migrate deploy` — this project applies schema via db
push/manual diffs rather than Prisma's tracked migration history, so a
branch created from main has every table but no `_prisma_migrations`
history, and `migrate deploy` fails with P3005 ("database schema is not
empty").

After that, every `npm run test:e2e` run behaves exactly as described
above — fixture rows are per-run-unique and cleaned up in teardown, so
re-running against this same branch indefinitely is safe. Re-run the two
commands above only after a schema change or a `prisma/seed.ts` change.
(CI re-runs both automatically before every run — see "Running in CI"
below.)

## Running in CI

`.github/workflows/ci.yml`'s `e2e` job runs this suite against the same
persistent `e2e-test` Neon branch described above, via two repo secrets —
`E2E_DATABASE_URL` (pooled) and `E2E_DIRECT_URL` (direct) — set as job-level
env vars the same way the `test` job sets `DATABASE_URL`/`DIRECT_URL`/
`TEST_DATABASE_URL`. `.env.e2e` never exists in CI, which is why
`--env-file-if-exists` (not `--env-file`) is used everywhere this suite
loads env files.

The job runs `prisma db push --accept-data-loss` and `prisma db seed`
before every run (both idempotent — see above) rather than trusting the
branch to already be in sync, and it carries a `concurrency` group so only
one e2e run executes at a time across the whole repo, including across
different PRs. That serialization exists because `resetLoginRateLimit`'s
bucket (see `e2e/fixtures/db.ts`) is keyed only by email, not scoped per
run — a single clean run already sits right at the 5-attempts/10-min login
budget for `organizer@chaap.dev`, so two runs hitting that same bucket at
once could trip a false "too many attempts" error instead of the
assertion each test expects. If this suite ever needs to run concurrently
against this branch, that rate-limit bucket (or Organization-scoped state
more generally) would need to be made run-aware first.

## Flagged tradeoffs (read before extending this suite)

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
