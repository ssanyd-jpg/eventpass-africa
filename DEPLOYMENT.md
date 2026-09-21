# Deploying Chaap

The schema is Postgres-only (`prisma/schema.prisma` — SQLite was only ever
a local-dev placeholder, retired once a real database existed). Local dev
and production both point at Neon Postgres now; this document covers the
Vercel + Neon setup and the optional providers (Vercel Blob for photos,
email/SMS, mobile money) that unlock features currently running in
simulated/fallback mode.

## 1. Neon Postgres (already provisioned for this project)

1. Neon dashboard → **Connection Details** has two connection strings:
   - **Pooled** → `DATABASE_URL` (what the app uses at runtime).
   - **Direct/unpooled** → `DIRECT_URL` (what Prisma migrations use — pooled connections don't support the session-level locking migrations need).
2. `binaryTargets = ["native", "rhel-openssl-3.0.x"]` is already set on the
   Prisma client generator — this matters specifically for Vercel's
   serverless runtime; without it, deploys can fail at request time with a
   "query engine not found" error even though the build succeeds.
3. Tests need their **own** Postgres database, never this one — see
   `TEST_DATABASE_URL` in `.env.example`. `npm test` runs `prisma db push
   --accept-data-loss` against it on every run, which would wipe real data
   if pointed at the dev/pilot database. A second free Neon **branch**
   (Neon dashboard → Branches → create from main) is the easiest way to get
   an isolated, disposable one.
4. `npm run test:e2e` runs the Playwright end-to-end suite (`e2e/`) against
   a real `next dev` server the Playwright config starts automatically.
   Unlike `npm test`, it currently runs against `DATABASE_URL` (the dev
   database) rather than an isolated one, since no equivalent of
   `TEST_DATABASE_URL` exists yet for a running Next server — see
   `e2e/README.md` for that tradeoff and how fixture data is created and
   cleaned up per run.

If starting a new environment from scratch instead of using the one
already set up: create a free project at neon.tech, copy the two
connection strings above into `.env`, then run:

```bash
npx prisma migrate dev --name init
npx prisma db seed         # optional — loads demo events/accounts
```

## 2. Deploy to Vercel

1. Push this repo to GitHub and import it in Vercel.
2. Add environment variables (Project Settings → Environment Variables):

   | Variable | Required | Notes |
   |---|---|---|
   | `DATABASE_URL` | Yes | Neon pooled connection string |
   | `DIRECT_URL` | Yes | Neon direct connection string |
   | `NEXTAUTH_SECRET` | Yes | Generate with `openssl rand -base64 32` |
   | `NEXTAUTH_URL` | Yes | Your production URL, e.g. `https://your-app.vercel.app` |
   | `BLOB_READ_WRITE_TOKEN` | No | Enables real event photo uploads — see §3 |
   | `RESEND_API_KEY` | No | Enables real email delivery — see §4 |
   | `CHAAP_FROM_EMAIL` | No | Sender address for real email (default: `noreply@chaap-africa.com`) — see §4 |
   | `AT_API_KEY` / `AT_USERNAME` | No | Enables real SMS delivery via Africa's Talking — both required together, see §4 |
   | `AT_WHATSAPP_USERNAME` / `AT_WHATSAPP_SHORTCODE` | No | Enables real WhatsApp delivery via Africa's Talking (with `AT_API_KEY`) — see §4 |
   | `AT_USSD_SECRET` | No | Enables the USSD endpoint (`/api/ussd`) for feature-phone attendees — without it every request is rejected. See §8 |
   | `CRON_SECRET` | No | Required to enable the 24h event-reminder Vercel Cron job — see §6 |
   | `AIRPAY_MERCHANT_ID` / `AIRPAY_CLIENT_ID` / `AIRPAY_CLIENT_SECRET` / `AIRPAY_USERNAME` / `AIRPAY_PASSWORD` / `AIRPAY_SECRET` / `AIRPAY_MERCHANT_DOMAIN` | No | Enables real mobile money charging via Airpay Tanzania — see §5 |

3. Deploy. `npm run build` runs the same way it does locally.

## 3. Photo uploads (optional)

Without configuration, event photos stay as the `picsum.photos` placeholder
used today. To enable real uploads: in the Vercel dashboard, add a Blob
store to the project (Storage tab) — this automatically injects
`BLOB_READ_WRITE_TOKEN`. Nothing else to configure; `/api/upload` and the
event edit page's photo uploader already check for this token.

## 4. Email / SMS / WhatsApp

Real delivery is wired in: `src/lib/notifications.ts`'s `sendNotification()`
— the single choke point every caller (checkout, password reset, org
invites, wristband provisioning, low-balance warnings, wallet top-ups,
event reminders, ...) already goes through — calls `sendEmail()`
(`src/lib/email.ts`, via Resend) whenever `RESEND_API_KEY` is set, and
routes every buyer/attendee-facing SMS-shaped notification through
`sendWhatsApp()` (`src/lib/whatsapp.ts`, via Africa's Talking's WhatsApp
Business API, Tanzania-only) instead of `sendSMS()` directly — WhatsApp is
the primary channel attendees actually check in Tanzania. `sendWhatsApp()`
sends a real WhatsApp message when `AT_API_KEY`, `AT_WHATSAPP_USERNAME`,
and `AT_WHATSAPP_SHORTCODE` (the WhatsApp Business number registered to the
account — the SDK calls this `waNumber`) are all set; otherwise it falls
back to `sendSMS()` (`src/lib/sms.ts`), which itself sends real SMS via
Africa's Talking whenever both `AT_API_KEY` and `AT_USERNAME` are set.
Without any of those, the call still just lands in the `NotificationLog`
table, visible to admins at `/admin/notifications` — see the README's
"Simulated pieces" section — same dev-mode behavior as before, per channel.

**A note on Africa's Talking's WhatsApp sandbox**: as of this writing, its
sandbox endpoint is documented as "coming soon" — only the live/production
endpoint actually accepts WhatsApp sends. `AT_USERNAME=sandbox` (the
free-traffic sandbox this project's SMS already runs against) does **not**
currently support WhatsApp, so expect every WhatsApp send to fall back to
SMS (or to a console log, if SMS isn't configured either) until real
production WhatsApp credentials — a Meta-verified WhatsApp Business number
onboarded through Africa's Talking — are set.

SMS/WhatsApp need a phone number to send to, and no signup flow collects
one — `User.phone` is only ever populated opportunistically when a buyer
types a number at AIRPAY_ONLINE checkout (see `handleSellTickets`). An
attendee who never paid online (cash/offline order, or a walk-up wristband
provisioned by email) has no phone on file, so their WhatsApp/SMS sends are
silently skipped — they still get the email.

## 5. Mobile money charging (optional)

Checkout currently uses `src/lib/payments/simulated.ts` — no real charge
happens, matching how a single-venue pilot actually starts (cash/manual
mobile money collected in person, marked paid instantly). The chosen
aggregator is **Airpay Tanzania**, which fronts M-Pesa, Tigo Pesa, and
Airtel Money behind one merchant integration ("Seamless mobile money").

`src/lib/payments/airpay.ts` and `airpay-crypto.ts` implement Airpay's
Collection API — OAuth token exchange, the AES-256-CBC/checksum envelope
their form-encoded calls require, the Seamless charge call, and
`verifyAirpayOrder()` for polling a charge's final status (their API has
no webhook — status has to be polled, there's no callback route to build).
This was built from a merchant-provided API reference, not Airpay's public
site (they don't publish this), so a few details are documented as
assumptions in `airpay-crypto.ts`'s comments (exact IV encoding in
`encdata`, the checksum's date format) — **test against Airpay's sandbox
and confirm these before any real charge runs through it.**

Set all seven `AIRPAY_*` env vars (see `.env.example`) to activate it —
`getActivePaymentProvider()` in `src/lib/payments/index.ts` only switches
over once every one of them is present. It is **not** wired into checkout
yet — see `airpay.ts`'s comments and the README for why (a real charge is
asynchronous; checkout needs a "waiting for you to confirm on your phone"
state and a network selector that don't exist yet), and treat that as a
follow-up task once credentials are verified against the sandbox.

## 6. Event reminders (Vercel Cron)

`src/lib/reminders.ts`'s `sendEventReminders()` finds every LIVE event
starting in roughly 24 hours and sends each ticket holder with a phone on
file a WhatsApp (falling back to SMS/log, same as every other notification)
reminder with their current wallet balance and the event's start time.
`src/app/api/cron/reminders/route.ts` exposes this as a `GET` endpoint that
only runs the job when the request's `Authorization: Bearer <token>` header
matches `CRON_SECRET` — set that env var (`openssl rand -base64 32`) for
this to do anything at all; without it, the route always returns 401.

`vercel.json` schedules Vercel Cron to hit that route hourly
(`0 * * * *`). An hourly cadence rather than one exact "24h before" run is
deliberate: `sendEventReminders()`'s own query window is a 2-hour band
(23h–25h out) specifically so a slightly-late or one-off-missed run still
catches every event, and the real "don't remind the same attendee twice"
guarantee is a `NotificationLog` lookup keyed on event + recipient inside
the function itself, not the schedule. (Vercel's Hobby plan limits cron
jobs to once a day — on Hobby, change the schedule to something like
`0 9 * * *` and accept that a very-last-minute event announced with under
~24h notice may not get a reminder in.)

## 7. Waitlist notifications (Vercel Cron)

Session 26 — when an organiser enables the waitlist on an event (per-event
toggle at `/dashboard/events/[id]/waitlist`), a sold-out ticket tier shows
"Join waitlist" instead of "Sold out" on the public event page. Joining is
free and requires no account (guest entries are supported).

Two things drive who gets notified:

- **Immediately**, when a ticket actually becomes available — an order
  cancellation/refund, a declined mobile-money payment releasing its
  reserved inventory, or an organiser raising a ticket type's quantity —
  `releaseWaitlistCapacity()` (`src/lib/waitlist.ts`) notifies the next
  person in that ticket type's queue by WhatsApp (falling back to SMS/log,
  same as every other notification), with a 2-hour link to buy.
- **Every 30 minutes**, `src/app/api/cron/waitlist/route.ts` calls
  `expireStaleWaitlistNotifications()`, which expires any notified entry
  whose 2-hour window closed without a purchase and immediately cascades
  the same notification to the next person in line — a spot never sits
  idle waiting for the next tick.

The cron route is gated by the same `CRON_SECRET` bearer token as the
reminders route above — no separate env var needed. `vercel.json` schedules
it at `*/30 * * * *`. (Vercel's Hobby plan limits cron jobs to once a day —
on Hobby, change the schedule to once daily and accept that a freed spot may
sit unclaimed for up to a day before the next person on the list is
notified; the immediate on-cancellation/on-capacity-increase notification
above still fires right away regardless of plan, since that path doesn't go
through this cron at all. Pro plan removes the once-daily limit.)

## 8. USSD for feature phones (Africa's Talking)

Session 31 — attendees on basic feature phones (no smartphone, no data) can
dial a USSD shortcode to check their wallet balance, top up, and see their
last transaction. `src/lib/ussd.ts` runs the menu; `src/app/api/ussd/route.ts`
is the endpoint Africa's Talking calls on every keypress. It uses the same
Africa's Talking account as SMS/WhatsApp (§4) but is inbound-only, so it
needs no `AT_API_KEY` — just its own secret.

**Before you go live**

1. Generate a secret: `openssl rand -base64 32`.
2. Set it as `AT_USSD_SECRET` in Vercel (Project Settings → Environment
   Variables) and redeploy. With no secret set, `/api/ussd` answers `401` to
   everything — that is the default, deliberately.
3. **Configure real Airpay first (§5).** Until the `AIRPAY_*` variables are
   all set, top-ups run on the simulator, which marks every charge paid
   instantly — so anyone with a wallet could dial in and credit it for free.
   Don't set `AT_USSD_SECRET` in production until Airpay is live.

**Register the shortcode in the Africa's Talking dashboard**

1. Sign in to the Africa's Talking dashboard and switch to the app whose
   `AT_USERNAME` you use for SMS (use the **Sandbox** app to test first).
2. Go to **USSD** → **Create channel**.
3. Set the **callback URL** to `https://chaap.africa/api/ussd`.
4. Configure the channel to send the header `X-AT-USSD-Secret` with the value
   of `AT_USSD_SECRET`. The endpoint checks this header and nothing else —
   see the note below if the dashboard has no field for it.
5. Save the channel and **note the shortcode Africa's Talking assigns**
   (e.g. `*384*xxx#`). That is the number attendees dial; put it on tickets,
   wristband hand-outs, and event signage. In the sandbox, test it from the
   dashboard's USSD simulator (or the simulator's phone number) before
   applying for a production shortcode, which Africa's Talking provisions
   per network.

**Verify the header can actually be set.** The endpoint authenticates
callers by the `X-AT-USSD-Secret` header, but this was built without access
to a live Africa's Talking account — confirm in the channel form that a
custom header is possible. If it only accepts a callback URL, the secret
can't reach us and every real request will be rejected; in that case either
front the route with a proxy that adds the header, or change
`verifyUssdSecret()` (`src/lib/ussd.ts`) to read the secret from the URL
instead — don't leave the endpoint open.

**What the menu does**

- Callers are identified by the phone number Africa's Talking reports,
  matched against `User.phone` — so only an attendee who typed their number
  at online checkout (§4) has a wallet USSD can find. Anyone else hears
  "No Chaap wallet found for this number".
- **Top up** starts an Airpay charge via the same handler as the in-app
  top-up. Airpay answers `PENDING` (the M-Pesa prompt goes to the caller's
  phone), and the wallet is only credited once that charge is confirmed —
  today that happens when the attendee next opens the app (the wallet page
  polls it), **not** automatically. Until a background job polls pending
  top-ups, a feature-phone user who never opens the app will see the money
  leave their phone without the balance changing.
- Limits: TZS 2,000 minimum, TZS 500,000 maximum per top-up; TZS wallets
  only.

## Post-deploy checklist

- [ ] Log in as the seeded admin (`admin@chaap.dev` if you ran
      the seed script) and change that password immediately, or delete
      the seed accounts and create a real admin via the database directly.
- [ ] Confirm `/admin/notifications` is reachable — it's how you'll relay
      password resets and other notifications until a real email/SMS
      provider is wired up.
- [ ] Do one real offline test: load the app once online, then disable
      networking on the device and confirm browsing/buying/scanning still
      work (this is the entire point of the architecture — worth
      confirming on the actual deployed build, not just locally).

<!-- trigger -->
