# Session 22 — Performance audit

Scope: database queries, API response times, offline sync, bundle size,
and image/asset handling. Every item below was verified against the actual
codebase (query call sites, schema, sync engine, build output) before being
called a finding — several things the original brief assumed turned out to
already be fine, or to not apply to this schema at all; those are recorded
as "checked, no change" rather than silently skipped.

## 1. Database indexes

**Method**: grepped every `prisma.<model>.findMany`/`aggregate` call site
across the analytics, live-monitoring, vendor/sponsor dashboard, and sync
routes for their `where` filters, then cross-referenced against
`prisma/migrations/*/migration.sql` for which columns actually have an
index today. `EXPLAIN ANALYZE` was **not** useful for a before/after
comparison in this environment — the dev database currently holds single-
digit-to-low-tens row counts per table (8 events, 7 tickets, 4 orders, 4
wallet transactions), and Postgres correctly picks a sequential scan over
an index scan at that size regardless of what indexes exist. The findings
below are justified by query shape (an unindexed column filtered on every
request, on a table that grows unboundedly with ticket sales/check-ins/
wallet activity), not a measured plan-cost delta at today's toy scale.

**Fixed** (`prisma/schema.prisma` + `prisma/migrations/20260918090000_add_performance_indexes/`):

| Column | Who filters on it, unindexed until now |
|---|---|
| `Order.eventId` (+`status`) | `getOrganizerAnalyticsData`, `getPlatformAnalyticsData`, `getCustomerListData`, `getCustomerDetailData`, the sync pull route's `myOrders` |
| `Order.userId` | sync pull route's `myOrders`, `getCustomerDetailData` |
| `Ticket.eventId` | `getLiveEventData` (polled every 30s), `getOrganizerAnalyticsData`, `getPlatformAnalyticsData` |
| `WalletTransaction.walletId` (+`createdAt`) | every wallet's own transaction history, the vendor/sponsor dashboards' today-only queries, the sync pull route's `myWalletTransactions`, the AirPay reconciliation report. The only existing index touching this column was `@@unique([campaignId, walletId])`, which a plain `walletId` lookup can't use (`campaignId` is null on nearly every row). |

**Checked, no change needed**: `ChipTime.eventId` and
`SessionAttendance.eventSessionId` (the original brief's other two asks)
already have `@@index([eventId, timingPointId])` and
`@@index([eventId, eventSessionId])` respectively, from Sessions 12 and 19.
`WalletTransaction.eventId` and `Ticket.status` don't exist as columns —
`WalletTransaction` has no `eventId` (it's reached via `wallet.eventId`,
now covered by the new `walletId` index instead), and ticket status lives
on `Order.status`, not `Ticket`.

**Applying to the real database**: the migration file is written but not
yet run against dev/prod — needs `npx prisma migrate deploy` after explicit
confirmation, per this project's standing discipline for schema changes.
The Vitest suite's `db push`-based test setup already picks these up
automatically (see the full-suite run below).

## 2. API response times

- Added `src/lib/perf-log.ts` (`logIfSlow`) and wired it into the three
  highest-traffic/most latency-sensitive routes: `/api/sync/pull` (polled
  by every active device, ~every 20s), `/api/dashboard/events/[id]/live`
  (organizer live monitoring, polled every 30s), and
  `/api/events/[slug]/leaderboard` (public, unauthenticated, polled every
  30s by anyone watching a race).
- **Deviation from the literal brief, flagged**: the ask was to add this to
  the Next.js middleware. `src/middleware.ts`'s matcher deliberately
  excludes every `/api/*` path already ("API handlers do their own auth
  checks" — its own header comment), and it runs on the Edge runtime,
  which none of this app's API routes do (they use Prisma, which needs
  Node). Widening the middleware matcher to intercept API routes just to
  log timings would touch a security-sensitive, deliberately-scoped config
  for a logging feature — not worth the risk for the same outcome a
  per-route helper gets more safely.
- The live-monitoring and leaderboard routes were read end-to-end: neither
  has an N+1 query pattern — both already batch their reads via `findMany`/
  `Promise.all` with `select`/`include`, never a query inside a loop. Same
  check on `analytics-data.ts`, `sponsor-dashboard-data.ts`, and
  `airpay-reconciliation-data.ts` (all three explicitly named in the
  brief): none had an N+1 pattern to fix.

## 3. Offline sync — delta sync + parallel outbox flush

This was the single biggest finding. `/api/sync/pull` was fetching **every**
event on the platform (with ticket types, vendors, registration questions)
plus, for a logged-in user, their **entire** order/wallet/wallet-transaction/
vendor/sponsor/discount-code/survey-question history — unfiltered, in full
— on every single pull. `startAutoSync()` runs this on a 20-second
`setInterval`, forever, for every active device. This gets strictly worse
as an organization's history grows; it never shrinks.

**Fix**: `/api/sync/pull` now accepts an optional `?since=<ISO timestamp>`.
Nine of the payload's fields (`events`, `myOrders`, `myVendors`,
`mySponsors`, `myCampaigns`, `myDiscountCodes`, `mySurveyQuestions`,
`myWallets`, `myWalletTransactions`) filter to `updatedAt > since` when
present. `pullFromServer` (`src/lib/sync-engine.ts`) now sends its last
successful pull's server-reported timestamp back as `since`, so a warmed-up
device only receives what actually changed since ~20 seconds ago instead
of its organization's whole history.

This was verified safe, not assumed safe, before shipping it:
- **Grepped for hard deletes**: zero `prisma.<model>.delete` call sites
  exist for any of the nine models above — every one is soft-stated
  (status/active flags) or immutable once created. That's what makes
  "only send what changed" safe without also tracking deletions.
- **Checked how the client merges each field**: `pullFromServer` already
  upserts by id/clientId (`bulkPut`, or a manual upsert-by-clientId loop)
  for all nine — never a destructive `clear()`-then-replace. (Five other
  fields — `pendingSurveys`, `recommendedEventIds`, `credentials`,
  `myTimingPoints`, `myConferenceSessions` — *do* full-replace, because
  they need to shrink when something is removed server-side; those were
  deliberately left out of delta filtering and still fetch in full every
  time.) Because nothing here is destructive, receiving a subset is exactly
  as correct as receiving everything.
- **Found and fixed two real staleness bugs a naive `updatedAt`-only filter
  would have introduced**, both because a child relation can change without
  touching its parent's own `updatedAt`:
  - `handleCheckIn` and ticket-transfer acceptance both update the
    `Ticket` row only, never its parent `Order`. A plain `Order.updatedAt`
    filter would let a check-in performed on one device (or a just-
    accepted transfer) never reach another device's delta pull. Fixed by
    widening `myOrders` to also match `tickets: { some: { updatedAt: {
    gt: since } } }`.
  - Every ticket sale increments `TicketType.quantitySold`, never
    `Event.updatedAt`. A plain filter would let the public browse/checkout
    page's "X left" count go stale under delta sync. Fixed the same way,
    widening `events` to also match `ticketTypes: { some: { updatedAt: {
    gt: since } } }`.
  - **Caught and fixed a real bug while writing this**: my first draft of
    the widened `myOrders` filter used a second top-level `OR` key
    alongside the existing access-control `OR` — a plain JS object literal,
    so the second `OR: [...]` silently overwrote the first one, which would
    have dropped the org/userId access-control filter entirely under delta
    sync. Fixed by explicitly `AND`-combining the two `OR` clauses instead
    of relying on object-spread key ordering.
- **Caught a second, more serious bug via the E2E suite, not by inspection**:
  the first full Playwright run after this change failed two tests —
  `gate-scan.spec.ts` (the "Entry granted." confirmation never appeared)
  and `vendor-terminal.spec.ts` (the vendor dropdown never populated) —
  both timing out after their full 75-second sync-retry budget. Root
  cause: this app calls `pullFromServer()` from the root layout on every
  page load, logged in or not (`Providers.tsx` → `startAutoSync()`), so an
  *anonymous* pull (the page loading before the test's login step
  completes) runs and sets a `since` cursor before any authenticated data
  has ever been fetched. That one shared cursor then got sent back on the
  very next, now-authenticated pull — silently delta-filtering
  `myVendors`/`myOrders`/etc. against a cursor newer than fixture rows
  that had never actually been fetched for this session, excluding them
  indefinitely. **Fixed** by splitting into two independent cursors:
  `since` (for the public `events` query, safe regardless of session) and
  `sinceAuth` (for the entire authenticated block), stored as separate
  Dexie `meta` keys (`lastSyncedAt` / `lastAuthSyncedAt`) —
  `lastAuthSyncedAt` only ever advances from a response that actually
  included the authenticated block (`Array.isArray(data.myOrders)`), so
  the first pull after logging in — or the very first pull ever, or the
  first pull after switching accounts on a shared device — is always a
  full, unfiltered fetch of that block. Re-ran the full Playwright suite
  after the fix: all 12 pass (see §7). **Known remaining gap, accepted**:
  logging out doesn't clear local Dexie state today (it never has,
  independent of this change), so a genuinely shared device where a
  *different* staff account logs in afterward would still delta-filter
  against the previous account's cursor. Narrower than the bug above
  (which fired on every fresh login, not just a shared-device handoff),
  and fixing it belongs with a proper logout-time data-clear, not this
  audit.
- **Clock source**: the cursor stored client-side is the *server's* clock
  (`data.now`, already returned by the route), not the client's own
  `Date.now()` — using the client's clock would silently lose rows under
  any client/server clock drift where the client runs fast.
- **Accepted, low-stakes staleness** (documented, not fixed): a few
  denormalized display-only fields — `ownerName`/`ownerEmail` on wallets,
  `vendorName`/`sponsorName`/`campaignName` on wallet transactions,
  `ticketTypeName` on discount codes — come from a *different* row (a
  `User`/`Vendor`/`Sponsor`/`TicketType` name) than the one the delta
  filter watches. If that name is edited independently, the label could
  show briefly stale until the wallet/transaction/code itself next changes.
  These are cosmetic (a rename, not a balance or access-control fact), so
  this wasn't chased further.
- **`MobileMoneyAccount` and `Settlement` were deliberately excluded** from
  delta filtering — neither has an `updatedAt` column, and both are small,
  low-frequency-change, per-organization datasets (config and periodic
  payouts, not per-transaction activity), so the win wasn't worth adding a
  column just to unlock it.

**Outbox flush parallelism**: `flushOutbox` processed every queued
operation strictly one at a time, `await`ing each network round trip before
starting the next — on a busy gate/wallet terminal serving many different
attendees, one slow request head-of-line-blocks everyone after it. Now
groups queued entries by the resource they mutate (which wallet, which
ticket, which physical wristband) and runs different resources' entries
concurrently, while entries sharing a resource still run strictly in their
original order — a second charge against the *same* wallet can never race
the first. Only the op types this audit actually traced a safe resource key
for (`TOPUP_WALLET`, `WITHDRAW_WALLET`, `CHARGE_WALLET`, `SPLIT_PAYMENT`,
`SPONSOR_TAP`, `CHECK_IN`, `CHECK_IN_VENDOR`, `RECORD_CHIP_TIME`,
`RECORD_SESSION_ATTENDANCE`, `SELL_TICKETS`) get real concurrency; every
other op type (event lifecycle, vendor/sponsor approvals, credential
replacement, withdrawal approvals, mobile money accounts, sponsor
campaigns — all rare, staff-desk actions, not a busy terminal's hot path)
shares one bucket and keeps today's exact sequential behavior. A bucket-key
mismatch (e.g. a `TOPUP_WALLET` queued immediately after the `CREATE_WALLET`
that hasn't synced yet, landing in a different bucket) is self-healing, not
corrupting: the server already returns `retry: true` for a not-yet-resolved
`walletClientId`, which every op in this system already relies on and
retries on the next flush cycle.

## 4. Bundle size

Ran `ANALYZE=true npm run build` (added `@next/bundle-analyzer`, wired
through `next.config.mjs`; disabled by default, zero effect on a normal
build). Findings:

- No route's First Load JS stands out — the largest is ~159 kB
  (`/account/wallet/[walletId]`), typical for a Dexie-backed offline app;
  the shared baseline is 87.3 kB.
- `africastalking`, `bcryptjs`, `resend`, `@vercel/blob`, and
  `@auth/prisma-adapter` — the heavy/sensitive server-only libraries named
  in the brief plus the other server-only ones in `package.json` — do
  **not** appear anywhere in the client bundle. Verified by searching the
  analyzer's client report for each package name.
- **Found, deferred**: `.prisma/client/index-browser.js` (Prisma's
  browser-safe stub — enum/type exports only, not the query engine) does
  appear in the client bundle, at 16.9 kB parsed / 3.45 kB gzipped. Traced
  the only two direct `@prisma/client` imports in `src/`:
  `organizations.ts` already uses `import type`, which TypeScript elides
  entirely; `prisma.ts`'s `import { PrismaClient }` is the real,
  necessary, server-only instantiation. Something in `prisma.ts`'s ~90-file
  transitive import fan-out is reachable from a client component, but
  tracing exactly which one wasn't pursued further — the entire cost is
  under 4% of even the largest route's First Load JS, and finding the
  precise culprit looked like it would cost more session time than the fix
  is worth. Left as a known, minor, deferred item.

## 5. Images and PWA assets

- `public/manifest.json`'s icons are a single SVG (`sizes: "any"`) used for
  both `any` and `maskable` purposes — already optimal; there's no "wrong
  size" for a vector icon the way there is for a PNG.
- Every `<img>` in the app (8 call sites) already carries an explicit
  `{/* eslint-disable-next-line @next/next/no-img-element */}` — a prior,
  deliberate decision, not an oversight. Checked whether converting them to
  `next/image` would help anyway:
  - 5 are the local `/icon.svg` logo on auth pages/navbar — a vector, above
    the fold, already tiny; `next/image` has nothing to optimize here.
  - 1 (`src/lib/email.ts`) is inside a raw HTML string for an email
    template — email clients need a plain `<img>`; a React component can't
    render there at all.
  - 2 (`events/[slug]/page.tsx`'s event hero image,
    `dashboard/events/[id]/edit/page.tsx`'s thumbnail) are real remote
    images that would otherwise be `next/image`'s best case — **but
    converting them would be a regression**, not an improvement: this
    app's PWA (`next.config.mjs`'s `runtimeCaching`) has a `CacheFirst`
    rule that caches `https://picsum.photos/*` responses directly for
    offline viewing. `next/image` would route every request through
    `/_next/image?url=...` instead, which isn't covered by that caching
    rule and needs a live round trip to Next's own image optimizer even on
    a repeat view — breaking exactly the offline-viewing capability this
    app is built around. Left as-is; the existing `<img>` + lint-disable is
    correct for this app's architecture, not a gap.

## 6. Performance regression test

Added `e2e/performance.spec.ts` — homepage, the general ticketed event
page, and the public leaderboard, each asserted under a 3-second budget.

**One necessary adjustment, flagged**: this suite runs against `next dev`
(see `playwright.config.ts`), which JIT-compiles each route's bundle on its
first-ever request (several seconds, unrelated to this app's own code) and
against Neon, whose compute can take 25-30s to wake from idle (the same
config's own documented number, also relied on by `leaderboard.spec.ts`'s
30-second assertion timeouts). A literal "fail past 3s on the very first
request of the run" test would fail almost every run in this environment
for reasons that have nothing to do with the app being slow, and would
never have caught this session's actual findings above either way. Each
page gets one untimed warm-up navigation first; the timed assertion is the
second navigation — a real production deployment (pre-built, database
already awake under normal traffic) never pays either one-time cost on a
genuine cold load, so this isolates the signal the test is actually for.

## 7. Full-suite results

- **Vitest**: 53 test files, **589 passed | 1 skipped (590 total)** —
  identical to the pre-audit baseline, no regressions. The new indexes
  applied cleanly via the test suite's `prisma db push` global setup.
- **Playwright**: all **12 specs pass** (8 pre-existing + the new
  `performance.spec.ts`'s 3 tests), full run in 4.1 minutes. This took two
  attempts: the first full run after the delta-sync change failed
  `gate-scan.spec.ts` and `vendor-terminal.spec.ts` — see §3's second bug
  writeup for the root cause and fix. Re-ran the full suite (not just the
  two failing specs) after the fix to confirm it holds under the same
  conditions that produced the original failures, not just in isolation.
- **`performance.spec.ts` results this run**: homepage 883ms–2.2s,
  event page 1.7–2.4s, public leaderboard 1.1–1.7s — all comfortably under
  the 3-second budget on every run (dev server, warm navigation).
- **Live proof the new response-time logging works**: it fired constantly
  throughout both E2E runs — e.g. `GET /api/sync/pull (full) took ~2.5-5.6s`
  and occasional `(delta)` pulls at 18-25s when Neon's compute had gone
  idle (documented, pre-existing behavior — see `playwright.config.ts`'s
  own comment on 25-30s cold-start latency; this environment's dev
  database, not this session's changes). In production, with a warmed
  connection pool and no dev-server JIT-compile overhead, the same code
  path is expected to log rarely, which is the point of a >500ms threshold
  logger — it should be quiet most of the time.

## What was not done, and why

- **Applying the new migration** (`prisma migrate deploy` for the three
  index additions) — needs explicit confirmation before running against a
  real database, per this project's standing schema-change discipline. The
  migration file is written and ready.
- **Tracing the exact culprit for the 3.45 kB gzipped Prisma browser stub**
  (§4) — real but small; further tracing looked like it would cost more
  time than the fix is worth.
- **A true logout-time Dexie/local-state clear** (§3's "known remaining
  gap") — would fix the narrower shared-device account-switch case, but is
  a separate, standalone piece of work, not a performance fix.
- **Truncating the ever-growing `myWalletTransactions`/`myOrders` history**
  to a rolling window — considered, but delta sync already solves the
  *repeated re-fetch* cost this would have targeted, without narrowing what
  a device can see (a buyer's own multi-event transaction history stays
  fully available offline). Doing both would be solving the same problem
  twice while accepting a real capability loss for no remaining benefit.
