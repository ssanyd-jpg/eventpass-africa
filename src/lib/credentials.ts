import { db } from "@/lib/db";

// Pure client-side uid -> code translation for NFC wristband resolution.
// Never touches the server — handleCheckIn/handleChargeWallet keep doing
// findUnique({where:{code}}) exactly as before; this just resolves what
// `code` to feed them, from the credentials table pulled down alongside
// everything else via /api/sync/pull.
export async function resolveCodeFromUid(uid: string, kind: "ticket" | "wallet"): Promise<string | null> {
  const rows = await db.credentials.where("nfcUid").equals(uid).toArray();
  const match = rows.find(
    (r) => r.status === "ACTIVE" && (kind === "ticket" ? !!r.ticketId : !!r.walletId)
  );
  return match?.code ?? null;
}

// Only meaningful to call after resolveCodeFromUid returns null — tells the
// gate/wallet terminal apart "this exact wristband was replaced" (see
// handleReplaceCredential) from "this uid was never provisioned at all."
// Requires the pull route to ship SUPERSEDED rows too, not just ACTIVE ones
// (see pull/route.ts) — otherwise a replaced tag simply vanishes from this
// device's cache on its next pull, indistinguishable from never existing.
export async function isUidSuperseded(uid: string, kind: "ticket" | "wallet"): Promise<boolean> {
  const rows = await db.credentials.where("nfcUid").equals(uid).toArray();
  return rows.some((r) => !!r.supersededAt && (kind === "ticket" ? !!r.ticketId : !!r.walletId));
}

// Session 13 — a wristband provisioned with a ticket gets two Credential
// rows sharing one uid (wallet-linked + ticket-linked, see
// handleProvisionCredential). The wallet charge terminal uses this
// alongside resolveCodeFromUid(uid, "wallet") to attribute a tap on a group
// wallet to the specific member's ticket — see CHARGE_WALLET's
// attendeeTicketId.
export async function resolveTicketIdFromUid(uid: string): Promise<string | null> {
  const rows = await db.credentials.where("nfcUid").equals(uid).toArray();
  const match = rows.find((r) => r.status === "ACTIVE" && !!r.ticketId);
  return match?.ticketId ?? null;
}
