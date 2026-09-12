import type { NextAuthConfig } from "next-auth";

// Provider-free base config, shared by the full auth.ts (Node runtime — API
// routes, server components) and middleware.ts (Edge runtime). Keeping
// Credentials/bcrypt out of this file is what keeps bcryptjs out of the
// Edge middleware bundle, where it isn't supported.
export const authConfig: NextAuthConfig = {
  trustHost: true,
  session: { strategy: "jwt" },
  pages: { signIn: "/login" },
  providers: [],
  callbacks: {
    async jwt({ token, user }) {
      if (user) {
        const u = user as {
          role?: string;
          organizationId?: string;
          organizationRole?: string;
          organizationName?: string;
          sessionId?: string;
          // VENDOR sessions only (see the vendor-magic-link provider in
          // auth.ts) — deliberately absent for every other session type,
          // never defaulted to a real value, so a vendor-scoped check can
          // never accidentally pass for a staff/buyer session or vice versa.
          vendorId?: string;
          eventId?: string;
          // SPONSOR sessions only (see the sponsor-magic-link provider in
          // auth.ts) — same isolation discipline as vendorId above.
          sponsorId?: string;
        };
        token.id = user.id;
        token.role = u.role ?? "USER";
        token.organizationId = u.organizationId;
        token.organizationRole = u.organizationRole;
        token.organizationName = u.organizationName;
        token.sessionId = u.sessionId;
        token.vendorId = u.vendorId;
        token.eventId = u.eventId;
        token.sponsorId = u.sponsorId;
        // Just created — skip an immediate revocation re-check on the very
        // next request (see auth.ts's periodic-recheck block).
        token.sessionRevocationCheckedAt = Date.now();
      }
      return token;
    },
    async session({ session, token }) {
      if (session.user && token.id) {
        session.user.id = token.id as string;
        session.user.role = (token.role as string) ?? "USER";
        session.user.organizationId = token.organizationId as string;
        session.user.organizationRole = token.organizationRole as string;
        session.user.organizationName = token.organizationName as string;
        session.user.vendorId = token.vendorId as string | undefined;
        session.user.eventId = token.eventId as string | undefined;
        session.user.sponsorId = token.sponsorId as string | undefined;
      }
      if (typeof token.sessionId === "string") {
        session.sessionId = token.sessionId;
      }
      return session;
    },
  },
};
