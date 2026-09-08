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
   | `AIRPAY_MERCHANT_ID` / `AIRPAY_CLIENT_ID` / `AIRPAY_CLIENT_SECRET` / `AIRPAY_USERNAME` / `AIRPAY_PASSWORD` / `AIRPAY_SECRET` / `AIRPAY_MERCHANT_DOMAIN` | No | Enables real mobile money charging via Airpay Tanzania — see §5 |

3. Deploy. `npm run build` runs the same way it does locally.

## 3. Photo uploads (optional)

Without configuration, event photos stay as the `picsum.photos` placeholder
used today. To enable real uploads: in the Vercel dashboard, add a Blob
store to the project (Storage tab) — this automatically injects
`BLOB_READ_WRITE_TOKEN`. Nothing else to configure; `/api/upload` and the
event edit page's photo uploader already check for this token.

## 4. Email / SMS

Real delivery is wired in: `src/lib/notifications.ts`'s `sendNotification()`
— the single choke point every caller (checkout, password reset, org
invites, wristband provisioning, low-balance warnings, ...) already goes
through — calls `sendEmail()` (`src/lib/email.ts`, via Resend) whenever
`RESEND_API_KEY` is set, and `sendSMS()` (`src/lib/sms.ts`, via Africa's
Talking, Tanzania-only) whenever both `AT_API_KEY` and `AT_USERNAME` are
set. Without those, every call still just lands in the `NotificationLog`
table, visible to admins at `/admin/notifications` — see the README's
"Simulated pieces" section — same dev-mode behavior as before, per channel.

SMS needs a phone number to send to, and no signup flow collects one —
`User.phone` is only ever populated opportunistically when a buyer types a
number at AIRPAY_ONLINE checkout (see `handleSellTickets`). An attendee who
never paid online (cash/offline order, or a walk-up wristband provisioned
by email) has no phone on file, so their SMS sends are silently skipped —
they still get the email.

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
