import NextAuth from "next-auth";
import { NextResponse } from "next/server";
import { authConfig } from "@/auth.config";
import { resolveVendorRedirect } from "@/lib/vendor-access";

// Separate, provider-free NextAuth instance for the Edge runtime — see
// auth.config.ts for why this can't just import the full auth.ts.
const { auth } = NextAuth(authConfig);

export default auth((req) => {
  const path = req.nextUrl.pathname;

  // VENDOR sessions (Session 8's vendor portal — see src/lib/vendor-auth.ts
  // and the "vendor-magic-link" provider in auth.ts) are confined to their
  // own portal, full stop — "cannot access any organiser or admin routes"
  // is a blanket rule, not an enumerated list, so this checks BEFORE the
  // path-specific branches below and covers every page in the app (see the
  // broadened matcher below), not just the organiser surfaces already
  // listed there for GATE_CREW. This is also what stops a vendor session
  // from invoking an organiser Server Action directly: a Next.js Server
  // Action POSTs to the same route as the page that defines it, so it's
  // caught here before that action ever runs — no need to touch every
  // individual organiser action file to add a vendor check. The actual
  // decision logic is in resolveVendorRedirect (src/lib/vendor-access.ts),
  // a plain function so it's directly unit-testable.
  const vendorRedirect = resolveVendorRedirect(req.auth?.user, path);
  if (vendorRedirect) {
    const url = req.nextUrl.clone();
    url.pathname = vendorRedirect;
    return NextResponse.redirect(url);
  }

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
    /^\/scan\/[^/]+\/provision(\/|$)/.test(path) ||
    /^\/scan\/[^/]+\/replace(\/|$)/.test(path);

  if (isGateCrewRestricted && req.auth?.user?.organizationRole === "GATE_CREW") {
    const url = req.nextUrl.clone();
    url.pathname = "/dashboard";
    return NextResponse.redirect(url);
  }

  return NextResponse.next();
});

export const config = {
  matcher: [
    // Runs the middleware on every page (excluding static assets, images,
    // and API routes — API handlers do their own auth checks) so the
    // VENDOR-confinement check above applies everywhere, not just the
    // specific organiser paths already enumerated below for GATE_CREW. The
    // more specific entries after this are redundant with it but kept
    // as-is, unchanged, for the GATE_CREW/ADMIN logic that predates this.
    "/((?!api|_next/static|_next/image|favicon.ico).*)",
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
    "/scan/:eventId/replace",
  ],
};
