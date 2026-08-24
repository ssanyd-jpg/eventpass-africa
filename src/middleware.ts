import NextAuth from "next-auth";
import { NextResponse } from "next/server";
import { authConfig } from "@/auth.config";

// Separate, provider-free NextAuth instance for the Edge runtime — see
// auth.config.ts for why this can't just import the full auth.ts.
const { auth } = NextAuth(authConfig);

export default auth((req) => {
  const isAdminRoute = req.nextUrl.pathname.startsWith("/admin");
  if (!isAdminRoute) return NextResponse.next();

  const role = req.auth?.user?.role;
  if (role !== "ADMIN") {
    const url = req.nextUrl.clone();
    url.pathname = "/login";
    url.searchParams.set("callbackUrl", req.nextUrl.pathname);
    return NextResponse.redirect(url);
  }

  return NextResponse.next();
});

export const config = {
  matcher: ["/admin/:path*"],
};
