import { NextResponse } from "next/server";
import { z } from "zod";
import { processRenewal, declineRenewal } from "@/lib/season-renewal";

// Public, token-authenticated — no sign-in (the renewal token itself is the
// credential, same as vendor/sponsor magic links). Handles both buttons on
// /renew/[token]: "Renew now" (action: "renew") and "No thanks"
// (action: "decline").
const bodySchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("renew"), phoneNumber: z.string().min(1), mobileNetwork: z.string().optional() }),
  z.object({ action: z.literal("decline") }),
]);

export async function POST(request: Request, { params }: { params: { token: string } }) {
  const parsed = bodySchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ ok: false, error: "Invalid request." }, { status: 400 });
  }

  if (parsed.data.action === "decline") {
    const result = await declineRenewal(params.token);
    return NextResponse.json(result, { status: result.ok ? 200 : 400 });
  }

  const result = await processRenewal(params.token, {
    phoneNumber: parsed.data.phoneNumber,
    mobileNetwork: parsed.data.mobileNetwork,
  });
  return NextResponse.json(result, { status: result.ok ? 200 : 400 });
}
