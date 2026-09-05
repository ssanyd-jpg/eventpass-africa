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
