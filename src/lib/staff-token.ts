/**
 * Short-lived JWT for the Chaap Staff mobile app.
 *
 * The mobile app can't use NextAuth session cookies (no browser, no CSRF),
 * so we issue a signed bearer token at /api/staff/login and verify it on
 * every /api/staff/* call. Token lifetime: 12 hours (enough for a full event
 * day; staff re-login the next morning).
 *
 * Signing key reuses NEXTAUTH_SECRET — same secret, different "aud" claim so
 * these tokens can never be confused with NextAuth session tokens.
 */

import { SignJWT, jwtVerify, type JWTPayload } from "jose";

const AUD = "chaap-staff-app";
const TTL = 12 * 60 * 60; // 12 hours in seconds

function getKey(): Uint8Array {
  const secret = process.env.NEXTAUTH_SECRET;
  if (!secret) throw new Error("NEXTAUTH_SECRET is not set");
  return new TextEncoder().encode(secret);
}

export interface StaffTokenPayload extends JWTPayload {
  userId: string;
  name: string;
  role: "OWNER" | "STAFF" | "GATE_CREW";
  orgId: string;
  eventId: string;
  eventName: string;
}

export async function signStaffToken(payload: Omit<StaffTokenPayload, keyof JWTPayload>): Promise<string> {
  return new SignJWT({ ...payload })
    .setProtectedHeader({ alg: "HS256" })
    .setAudience(AUD)
    .setIssuedAt()
    .setExpirationTime(`${TTL}s`)
    .sign(getKey());
}

export async function verifyStaffToken(token: string): Promise<StaffTokenPayload> {
  const { payload } = await jwtVerify(token, getKey(), { audience: AUD });
  return payload as StaffTokenPayload;
}

export function extractBearerToken(authHeader: string | null): string | null {
  if (!authHeader?.startsWith("Bearer ")) return null;
  return authHeader.slice(7);
}
