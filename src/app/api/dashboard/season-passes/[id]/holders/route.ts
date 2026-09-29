import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { getSeasonPassDetail } from "@/lib/season-pass";
import { buildCsvDocument, type CsvSection } from "@/lib/csv";

// CSV export of one season pass's holders — same shape as the loyalty
// redemptions export route.
export async function GET(_request: Request, { params }: { params: { id: string } }) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ ok: false, reason: "UNAUTHENTICATED" }, { status: 401 });
  }
  if (session.user.organizationRole === "GATE_CREW") {
    return NextResponse.json({ ok: false, reason: "FORBIDDEN" }, { status: 403 });
  }

  const pass = await getSeasonPassDetail(session.user.organizationId, params.id);
  if (!pass) {
    return NextResponse.json({ ok: false, reason: "NOT_FOUND" }, { status: 404 });
  }

  const sections: CsvSection[] = [
    {
      title: `${pass.name} — holders`,
      headers: ["Name", "Phone", "Email", "Purchased At", "Renewal Status"],
      rows: pass.holders.map((h) => [h.name, h.phone, h.email ?? "", h.purchasedAt, h.renewalStatus]),
    },
  ];

  const csv = buildCsvDocument(sections);
  const filename = `chaap-season-pass-holders-${new Date().toISOString().slice(0, 10)}.csv`;

  return new NextResponse(csv, {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="${filename}"`,
    },
  });
}
