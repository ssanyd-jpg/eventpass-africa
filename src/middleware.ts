import NextAuth from "next-auth";
import { NextResponse } from "next/server";
import { authConfig } from "@/auth.config";

// Separate, provider-free NextAuth instance for the Edge runtime — see
// auth.config.ts for why this can't just import the full auth.ts.
const { auth } = NextAuth(authConfig);

export default auth((req) => {
  const path = req.nextUrl.pathname;

  if (path.startsWith("/admin")) {
    if (req.auth?.user?.role !== "ADMIN") {
      const url = req.nextUrl.clone();
      url.pathname = "/login";
      url.searchParams.set("callbackUrl", path);
      return NextResponse.redirect(url);
    }
    return NextResponse.next();
  }

  // GATE_CREW is event-day door staff — scoped to the gate scanner only.
  // Real enforcement is server-side (see src/lib/access-control.ts and the
  // organizationId checks in sync-handlers.ts); this redirect just keeps
  // the UI from rendering surfaces they can't act on, and matters even
  // offline since the PWA service worker precaches page shells.
  const isGateCrewRestricted =
    path.startsWith("/dashboard/events") ||
    path.startsWith("/dashboard/team") ||
    path.startsWith("/dashboard/audit") ||
    path.startsWith("/dashboard/settlements") ||
    path.startsWith("/dashboard/analytics") ||
    path.startsWith("/dashboard/devices") ||
    path.startsWith("/dashboard/customers") ||
    path.startsWith("/dashboard/support") ||
    path.startsWith("/dashboard/withdrawals") ||
    path.startsWith("/dashboard/payments") ||
    /^\/scan\/[^/]+\/wallet(\/|$)/.test(path) ||
    /^\/scan\/[^/]+\/provision(\/|$)/.test(path);

  if (isGateCrewRestricted && req.auth?.user?.organizationRole === "GATE_CREW") {
    const url = req.nextUrl.clone();
    url.pathname = "/dashboard";
    return NextResponse.redirect(url);
  }

  return NextResponse.next();
});

export const config = {
  matcher: [
    "/admin/:path*",
    "/dashboard/events/:path*",
    "/dashboard/team/:path*",
    "/dashboard/audit/:path*",
    "/dashboard/settlements/:path*",
    "/dashboard/analytics/:path*",
    "/dashboard/devices/:path*",
    "/dashboard/customers/:path*",
    "/dashboard/support/:path*",
    "/dashboard/withdrawals/:path*",
    "/dashboard/payments/:path*",
    "/scan/:eventId/wallet",
    "/scan/:eventId/provision",
  ],
};
