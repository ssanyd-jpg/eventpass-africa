import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { getVendorDashboardData } from "@/lib/vendor-dashboard-data";

// Polled by the vendor dashboard page every 60s (see point 3 of the Session
// 8 spec — vendors don't need the 30s cadence the organiser live-monitoring
// page uses). The ONLY auth this route accepts is a VENDOR session whose
// vendorId matches the route param — an organiser session (no vendorId at
// all) or a different vendor's session both get the same 403, same
// reasoning as every other org-scoped route in this app comparing against
// a real value rather than trusting an unfiltered query. The actual data
// query lives in getVendorDashboardData (src/lib/vendor-dashboard-data.ts),
// split out so it's directly testable without going through auth().
export async function GET(request: Request, { params }: { params: { vendorId: string } }) {
  const session = await auth();
  if (session?.user?.role !== "VENDOR" || session.user.vendorId !== params.vendorId) {
    return NextResponse.json({ ok: false, reason: "FORBIDDEN" }, { status: 403 });
  }

  const data = await getVendorDashboardData(params.vendorId);
  if (!data) {
    return NextResponse.json({ ok: false, reason: "NOT_FOUND" }, { status: 404 });
  }

  return NextResponse.json({ ok: true, ...data });
}
