/**
 * Thin API client — all calls go to EXPO_PUBLIC_API_URL (set in .env).
 * Each function mirrors an existing chaap.africa API route.
 */

const BASE = process.env.EXPO_PUBLIC_API_URL ?? "https://chaap.africa";

async function post<T>(path: string, body: unknown, token: string): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(body),
  });
  const json = await res.json();
  if (!res.ok) throw new Error(json.error ?? `HTTP ${res.status}`);
  return json as T;
}

async function get<T>(path: string, token: string): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const json = await res.json();
  if (!res.ok) throw new Error(json.error ?? `HTTP ${res.status}`);
  return json as T;
}

// ── Auth ──────────────────────────────────────────────────────────────────

export interface StaffSession {
  token: string;
  name: string;
  role: "OWNER" | "STAFF" | "GATE_CREW";
  eventId: string;
  eventName: string;
  vendorId: string | null;
  vendorName: string | null;
}

export async function staffLogin(email: string, password: string, eventId: string): Promise<StaffSession> {
  return post<StaffSession>("/api/staff/login", { email, password, eventId }, "");
}

// ── Gate scanner ──────────────────────────────────────────────────────────

export interface ScanResult {
  valid: boolean;
  ticketCode: string;
  holderName: string;
  ticketType: string;
  alreadyUsed: boolean;
  message: string;
}

export async function validateTicket(
  nfcUid: string,
  eventId: string,
  token: string
): Promise<ScanResult> {
  return post<ScanResult>("/api/staff/scan", { nfcUid, eventId }, token);
}

// ── Wristband provisioning ────────────────────────────────────────────────

export interface ProvisionResult {
  success: boolean;
  ticketCode: string;
  holderName: string;
  wristbandUid: string;
}

export async function provisionWristband(
  ticketCode: string,
  nfcUid: string,
  eventId: string,
  token: string
): Promise<ProvisionResult> {
  return post<ProvisionResult>("/api/staff/provision", { ticketCode, nfcUid, eventId }, token);
}

// ── Vendor tap-to-pay ─────────────────────────────────────────────────────

export interface DebitResult {
  success: boolean;
  amountDebitedCents: number;
  newBalanceCents: number;
  holderName: string;
  transactionId: string;
}

export async function vendorDebit(
  nfcUid: string,
  amountCents: number,
  vendorId: string,
  eventId: string,
  token: string
): Promise<DebitResult> {
  return post<DebitResult>("/api/staff/debit", { nfcUid, amountCents, vendorId, eventId }, token);
}

// ── Organiser dashboard ───────────────────────────────────────────────────

export interface EventStats {
  checkedIn: number;
  totalTickets: number;
  cashlessRevenueCents: number;
  activeVendors: number;
  topVendors: { name: string; revenueCents: number }[];
  lastUpdated: string;
}

export async function getEventStats(eventId: string, token: string): Promise<EventStats> {
  return get<EventStats>(`/api/staff/stats?eventId=${encodeURIComponent(eventId)}`, token);
}
