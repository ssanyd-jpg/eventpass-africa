# Chaap

An offline-first event ticketing platform — browse events, sell tickets,
scan gate entry, manage refunds, and settle vendor payouts, all designed
to keep working with zero connectivity (built with Tanzanian venues in
mind, where connectivity at the door is often unreliable).

## Stack

- **Next.js 14** (App Router) + TypeScript + Tailwind
- **Prisma + SQLite locally / Postgres in production** — the "cloud"
  backend / source of truth (see [DEPLOYMENT.md](DEPLOYMENT.md) for the
  Postgres switch)
- **NextAuth (Auth.js v5)** — credentials-based auth, with a `role`
  (`USER`/`ADMIN`) on every session
- **Dexie (IndexedDB)** — the local-first client data layer everything
  reads from and writes to first
- **next-pwa** — installable PWA shell + service worker asset caching
- **Vitest** — unit + integration tests against a real (disposable) SQLite
  database

## Getting started

```bash
npm install
npx prisma migrate deploy
npx prisma db seed
npm run dev
```

Visit http://localhost:3000. Demo accounts (password `password123`):

- `organizer@chaap.dev` / `promoter@chaap.dev` — organizer
  accounts, already own the seeded events
- `fan@chaap.dev` — attendee account
- `admin@chaap.dev` — platform admin (`/admin`)

Run the test suite with `npm test`.

## How the offline-first architecture works

Every page reads and writes **local IndexedDB data (via Dexie)**, never the
server directly. A background sync engine (`src/lib/sync-engine.ts`):

- **Pulls** the event catalog and your orders/settlements down into IndexedDB
  whenever you're online (`/api/sync/pull`).
- **Queues** every mutation — buying tickets, creating/editing/cancelling an
  event, checking in a ticket, issuing a refund, adding a mobile money
  account — into a local `outbox` table. These apply to local data
  immediately (optimistic), so the UI never waits on the network.
- **Flushes** the outbox to `/api/sync/push` whenever the browser regains
  connectivity, reconciling client-generated temporary IDs with the
  server-assigned ones.

This means: browsing, buying, gate scanning (including camera QR scanning),
and dashboard stats all work with the network fully off. Sign-in and
creating a brand-new account still need a connection the first time
(there's no way around authenticating against nothing) — after that, the
session persists offline. Ticket codes are generated **client-side at
purchase time** and the server reuses those exact codes during sync,
rather than generating its own — the code a buyer sees is guaranteed to be
the one that's actually valid at the gate.

## Feature tour

- **Multi-currency** — each event picks its own currency at creation
  (`src/lib/currency.ts` has the supported list: TZS, KES, UGX, RWF, ZAR,
  NGN, GHS, USD, EUR, GBP) and it's locked once the event has any ticket
  sales, so historical totals never silently go wrong. Every aggregate view
  (organizer dashboard revenue, settlements, admin totals) groups by
  currency instead of summing across them — an organizer running both a
  TZS event and a USD conference sees two numbers, never one meaningless
  mixed total.
- **Browse, buy, my tickets** — with a real scannable QR code per ticket
  (`src/components/TicketQr.tsx`, generated locally via the `qrcode`
  package — no network dependency).
- **Organizer dashboard** — create, edit, and cancel events (cancelling
  hides an event from public browse but keeps it visible, badged, to the
  organizer and existing ticket holders); per-order refunds (blocked once
  an order's already been paid out in a settlement, since that needs
  manual reconciliation with the organizer's mobile money provider).
- **Gate scanner** (`/scan/[eventId]`) — manual code entry always works;
  a camera-scan mode layers on top via the browser's native
  `BarcodeDetector` API when available (Chrome/Android has broad support
  on the low/mid-range devices this targets) — pure progressive
  enhancement, no third-party decoding library.
- **Settlements** — simulated same-day mobile money payouts (see below).
- **Password reset** — request/reset flow; until a real email provider is
  connected, the reset link is relayed through `/admin/notifications`
  (see "Simulated pieces").
- **Admin panel** (`/admin`, gated by `role: "ADMIN"` in
  `src/middleware.ts`) — users, events (with a moderation "unpublish"
  action independent of the organizer's own cancel), orders, platform-wide
  settlement totals, and the notification log.
- **English / Swahili toggle** — in the navbar, covers the highest-traffic
  surfaces (nav, home, login, gate scanner). Swahili strings
  (`src/lib/i18n.ts`) are a first-pass machine translation flagged for
  native-speaker review before real pilot use — not every string in the
  app is covered yet.
- **Security** — CSP + standard security headers (`next.config.mjs`), a
  DB-backed rate limiter on login/register/password-reset (no Redis
  needed — `src/lib/rate-limit.ts`), zod validation on every mutating API
  route.

## Testing true offline behavior

The service worker (which lets the app boot with literally zero network) is
intentionally **disabled during `npm run dev`** — next-pwa regenerates it on
every request in dev mode, which causes an infinite rebuild loop. To test the
real offline experience:

```bash
npm run build
npm run start
```

Then load the app once while online (so the catalog and shell cache), and
you can kill the network entirely and keep browsing/buying/scanning.

## Simulated pieces (by design)

- **Checkout** — online purchases (device connected) go through
  `getActivePaymentProvider()` (`src/lib/payments/`): an `airpayProvider`
  for **Airpay Tanzania** (fronts M-Pesa, Tigo Pesa, and Airtel Money behind
  one "Seamless mobile money" integration) when all `AIRPAY_*` env vars are
  set, falling back to a `SimulatedProvider` (instant "paid", no real
  charge) otherwise — so checkout works end-to-end in dev/pilot without
  real credentials. `airpayProvider` implements Airpay's actual Collection
  API (OAuth token exchange, their AES-256-CBC/checksum request envelope,
  the charge call, and poll-based order verification — see
  `src/lib/payments/airpay.ts` and `airpay-crypto.ts`), built from a
  merchant-provided API reference rather than Airpay's public site (they
  don't publish this). A few details in that reference are ambiguous and
  documented as assumptions in `airpay-crypto.ts`'s comments — confirm
  those against Airpay's sandbox before any real charge runs through it.
  Offline/in-person sales stay cash-in-hand, marked paid instantly, same as
  before this was wired up — see `getPaymentMode()` in
  `src/lib/payments/index.ts` for the online/offline split.
- **Settlements** (`/dashboard/settlements`) — models a same-day mobile
  money payout (M-Pesa TZ / Tigo Pesa / Airtel Money / HaloPesa): an
  organizer links an account, and "Run settlement now" aggregates unpaid
  orders into a payout record with a simulated reference number. No real
  funds move; `src/lib/settlement-handlers.ts` is the integration point
  where a real provider call would go.
- **Email / SMS** — every notification (order confirmations, password
  resets, cancellations, refunds, wristband provisioning, low wallet
  balance) goes through the single choke point `src/lib/notifications.ts`,
  which sends real email via Resend (`src/lib/email.ts`) when
  `RESEND_API_KEY` is set and real SMS via Africa's Talking
  (`src/lib/sms.ts`, Tanzania-only) when `AT_API_KEY`/`AT_USERNAME` are
  set. Without those, it logs to `NotificationLog` (visible at
  `/admin/notifications`) instead of sending anything, per channel — the
  original dev-mode behavior, unchanged for whichever isn't configured.
- **Event photo uploads** — events default to a `picsum.photos` placeholder
  image. `/api/upload` and the edit page's uploader use Vercel Blob when
  `BLOB_READ_WRITE_TOKEN` is set, and fall back to the placeholder
  behavior entirely when it isn't.

## Known limitations

- Offline conflict handling is intentionally simple: if the same ticket type
  gets oversold across multiple offline devices before they sync, the order
  is flagged `NEEDS_REVIEW` server-side rather than rejected outright (real
  point-of-sale systems generally favor honoring an already-issued ticket
  and reconciling refunds/comps after the fact over silently invalidating a
  sale).
- Swahili coverage is partial (see "Feature tour" above) and machine-drafted.
- No Playwright/e2e browser automation suite — the critical paths (offline
  purchase, gate scan, refund, settlement, admin moderation, password
  reset) have all been manually verified live in-browser repeatedly during
  development, including genuine offline tests (killing the server
  mid-session), but there's no automated script re-running that today.
