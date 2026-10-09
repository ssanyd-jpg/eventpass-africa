# Chaap Staff App

Native Android app for event staff. Built with Expo SDK 57 / React Native 0.86.

## Screens

| Tab | Who uses it | What it does |
|-----|-------------|--------------|
| **Gate scanner** | Gate crew | NFC tap → green/red pass/fail, marks ticket checked-in |
| **Wristband provisioning** | Provisioning desk | Links an NFC wristband to a ticket; supports offline queue |
| **Vendor tap-to-pay** | Vendors | NFC tap → debits customer wallet, shows new balance |
| **Organiser dashboard** | Organiser / OWNER | Live attendance %, cashless revenue, top vendors — auto-refreshes every 30 s |

## Requirements

- Android 7.0+ with NFC hardware (for gate scan & provisioning)
- Expo Go **won't** work for NFC — build a dev client or preview APK instead
- Staff account on the Chaap platform (OWNER / STAFF / GATE_CREW role)

## Development

```bash
# Install dependencies (from the repo root)
npm install --legacy-peer-deps --ignore-scripts

# Start Metro bundler
npx expo start

# Run on a connected Android device
npx expo run:android
```

For a physical Android device without a dev build, use a preview APK (see Building below).

## Building (EAS)

```bash
npm install -g eas-cli
eas login

# Preview APK for internal distribution (sideload on any Android device)
eas build --platform android --profile preview

# Development build with expo-dev-client (needed to test NFC)
eas build --platform android --profile development
```

The resulting APK download link is sent to your EAS dashboard and email.

## Environment

| Variable | Description |
|----------|-------------|
| `EXPO_PUBLIC_API_URL` | Platform base URL. Defaults to `https://chaap.africa`. For local dev, set to your machine's LAN IP: `http://192.168.x.x:3000` |

Copy `.env` to `.env.local` and adjust for local testing.

## Backend API routes

All routes live in the Next.js app under `src/app/api/staff/`.

| Route | Method | Purpose |
|-------|--------|---------|
| `/api/staff/login` | POST | Email + password → signed 12-hour JWT |
| `/api/staff/scan` | POST | NFC UID or ticket code → check-in result |
| `/api/staff/provision` | POST | Ticket code + NFC UID → provision wristband |
| `/api/staff/debit` | POST | NFC UID + amount → charge wallet |

All routes (except `/login`) require `Authorization: Bearer <token>`.

## Auth flow

1. Staff opens app → enters work email + password + event ID
2. App calls `POST /api/staff/login` → receives a 12-hour JWT
3. JWT stored in AsyncStorage under `chaap_staff_session`
4. All subsequent API calls send `Authorization: Bearer <jwt>`
5. On app open, if a valid session exists, the user is taken straight to the tab bar

## NFC note

NFC reading uses `expo-nfc` (community package). In simulator / Expo Go, the NFC module is unavailable — all NFC screens detect this and show a **Simulate** button that returns mock data so the app can be fully tested without hardware.

## Project structure

```
mobile/
├── app.json              # Expo config (package name, permissions, plugins)
├── eas.json              # EAS build profiles
├── index.ts              # Expo Router entry point
├── .env                  # Environment variables template
└── src/
    ├── app/
    │   ├── _layout.tsx       # Root layout — session check, redirect logic
    │   ├── login.tsx          # Login screen
    │   └── (tabs)/
    │       ├── _layout.tsx    # Bottom tab navigator
    │       ├── scan.tsx        # Gate scanner
    │       ├── provision.tsx   # Wristband provisioning
    │       ├── vendor.tsx      # Vendor tap-to-pay
    │       └── dashboard.tsx   # Organiser dashboard
    └── lib/
        ├── api.ts             # API client (all fetch calls)
        └── auth.ts            # AsyncStorage session helpers
```
