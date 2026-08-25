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
        };
        token.id = user.id;
        token.role = u.role ?? "USER";
        token.organizationId = u.organizationId;
        token.organizationRole = u.organizationRole;
        token.organizationName = u.organizationName;
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
      }
      return session;
    },
  },
};
