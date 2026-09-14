import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { getExhibitorLeadsExportData, buildExhibitorLeadsCsv } from "@/lib/vendor-dashboard-data";
import { slugify } from "@/lib/format";

// CSV export of the exhibitor's own captured leads (point 4) — same VENDOR-
// session-matching-vendorId auth as /api/vendor/[vendorId]/dashboard beside
// it: only that vendor's own session can export their own leads.
export async function GET(_request: Request, { params }: { params: { vendorId: string } }) {
  const session = await auth();
  if (session?.user?.role !== "VENDOR" || session.user.vendorId !== params.vendorId) {
    return NextResponse.json({ ok: false, reason: "FORBIDDEN" }, { status: 403 });
  }

  const data = await getExhibitorLeadsExportData(params.vendorId);
  if (!data) {
    return NextResponse.json({ ok: false, reason: "NOT_FOUND" }, { status: 404 });
  }

  const csv = buildExhibitorLeadsCsv(data.vendorName, data.rows);
  const filename = `leads-${slugify(data.vendorName)}.csv`;

  return new NextResponse(csv, {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="${filename}"`,
    },
  });
}
