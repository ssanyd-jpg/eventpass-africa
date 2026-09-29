import { NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/auth";
import { purchaseSeasonPass } from "@/lib/season-pass";

const purchaseSchema = z.object({
  phoneNumber: z.string().min(1),
  mobileNetwork: z.string().optional(),
});

// Buying requires an account (the pass has to land somewhere — mirrors
// resale's own buy route), unlike viewing the pass on /season-passes/[id],
// which is public.
export async function POST(request: Request, { params }: { params: { id: string } }) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ ok: false, error: "Sign in to buy a season pass." }, { status: 401 });
  }

  const parsed = purchaseSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ ok: false, error: "Enter your mobile money number." }, { status: 400 });
  }

  const result = await purchaseSeasonPass(params.id, {
    userId: session.user.id,
    name: session.user.name ?? "Chaap user",
    phone: parsed.data.phoneNumber,
    email: session.user.email,
    mobileNetwork: parsed.data.mobileNetwork,
  });
  if (!result.ok) {
    return NextResponse.json(result, { status: 400 });
  }
  return NextResponse.json(result);
}
