import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { listRedemptionsForExport } from "@/lib/loyalty-rewards";
import { buildCsvDocument, type CsvSection } from "@/lib/csv";

// CSV export of every loyalty redemption — same shape as the volunteers/
// analytics export routes (text/csv attachment).
export async function GET() {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ ok: false, reason: "UNAUTHENTICATED" }, { status: 401 });
  }
  if (session.user.organizationRole === "GATE_CREW") {
    return NextResponse.json({ ok: false, reason: "FORBIDDEN" }, { status: 403 });
  }

  const redemptions = await listRedemptionsForExport(session.user.organizationId);

  const sections: CsvSection[] = [
    {
      title: "Loyalty redemptions",
      headers: ["Reward", "Type", "Attendee", "Email", "Tier", "Value", "Event", "Redeemed At"],
      rows: redemptions.map((r) => [
        r.rewardName,
        r.rewardType,
        r.userName,
        r.userEmail,
        r.tier,
        r.value,
        r.eventTitle ?? "",
        r.redeemedAt,
      ]),
    },
  ];

  const csv = buildCsvDocument(sections);
  const filename = `chaap-loyalty-redemptions-${new Date().toISOString().slice(0, 10)}.csv`;

  return new NextResponse(csv, {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="${filename}"`,
    },
  });
}
