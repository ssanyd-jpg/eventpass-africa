import { NextResponse } from "next/server";
import { expireStaleWaitlistNotifications } from "@/lib/waitlist";

export async function GET(request: Request) {
  const secret = process.env.CRON_SECRET;
  const authHeader = request.headers.get("authorization");

  if (!secret || authHeader !== `Bearer ${secret}`) {
    return NextResponse.json({ ok: false, reason: "UNAUTHORIZED" }, { status: 401 });
  }

  const result = await expireStaleWaitlistNotifications();
  return NextResponse.json(result);
}
