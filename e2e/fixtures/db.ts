import { readFileSync } from "fs";
import { PrismaClient } from "@prisma/client";

// A dedicated Prisma client for E2E setup/teardown/cleanup scripts. Deliberately
// NOT importing the app's own src/lib/prisma.ts (or anything else under src/)
// from here — Playwright's own TS transform doesn't need to resolve the app's
// "@/*" path alias this way, and it keeps this fixtures layer fully
// independent of application code, matching this session's "tests only, no
// application code" scope.
export const prisma = new PrismaClient();

export const FIXTURES_PATH = `${__dirname}/../.fixtures.json`;

export interface E2EFixtures {
  runId: string;
  organizerEmail: string;
  fanEmail: string;
  demoPassword: string;
  generalEventId: string;
  generalEventSlug: string;
  generalEventTitle: string;
  ticketTypeName: string;
  ticketTypePriceCents: number;
  gateTicketCode: string;
  vendorId: string;
  vendorName: string;
  vendorBadgeCode: string;
  walletCode: string;
  walletBalanceCents: number;
  sponsorId: string;
  sponsorName: string;
  vendorVerifyToken: string;
  sponsorVerifyToken: string;
  marathonEventId: string;
  marathonEventSlug: string;
  marathonEventTitle: string;
  marathonRaceTicketTypeName: string;
  marathonOtherTicketTypeName: string;
}

export function readFixtures(): E2EFixtures {
  return JSON.parse(readFileSync(FIXTURES_PATH, "utf8"));
}

// src/auth.ts rate-limits credentials login to 5 attempts per email per 10
// minutes (src/lib/rate-limit.ts). A full clean suite run already sits right
// at that budget for organizer@chaap.dev (auth, event-create, gate-scan, and
// vendor-terminal specs each log in as it), so any extra attempt — a retry,
// a manual re-run shortly after a previous one, a future spec added later —
// pushes it over and produces a confusing, unrelated-looking login failure.
// Every spec that logs in with a password calls this first so each of its
// own login attempts always has fresh budget, regardless of what any other
// spec or previous run already did to this bucket.
export async function resetLoginRateLimit(email: string) {
  await prisma.rateLimitHit.deleteMany({ where: { bucketKey: `login:${email}` } });
}
