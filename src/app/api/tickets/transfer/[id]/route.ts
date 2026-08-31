import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { getTransferByToken, acceptTransfer } from "@/lib/ticket-transfer";

// Route param is named `id` only because Next.js requires every dynamic
// segment at this path level to share one slug name (this folder also
// holds ./cancel, which addresses a transfer by its real DB id) — the
// VALUE passed here is always the raw, unhashed transfer token (see
// createTransfer/getTransferByToken/acceptTransfer in ticket-transfer.ts),
// never a database id.

// GET: public-ish lookup by raw token (same threat model as an
// OrganizationInvite link) so the accept page can render its two branches
// (existing-account sign-in vs inline sign-up) before the visitor acts.
export async function GET(_request: Request, { params }: { params: { id: string } }) {
  const info = await getTransferByToken(params.id);
  if (!info) {
    return NextResponse.json({ ok: false, error: "This transfer link is invalid." }, { status: 404 });
  }
  return NextResponse.json({ ok: true, ...info });
}

// POST: accept — requires the visitor to already be signed in with a
// matching email, mirrors organization/accept/route.ts exactly.
export async function POST(_request: Request, { params }: { params: { id: string } }) {
  const session = await auth();
  if (!session?.user?.id || !session.user.email) {
    return NextResponse.json({ ok: false, error: "Sign in to accept this ticket." }, { status: 401 });
  }

  const result = await acceptTransfer(params.id, session.user.id, session.user.email);
  if (!result.ok) {
    return NextResponse.json(result, { status: 400 });
  }
  return NextResponse.json(result);
}
