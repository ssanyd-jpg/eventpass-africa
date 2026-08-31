import NextAuth from "next-auth";
import Credentials from "next-auth/providers/credentials";
import bcrypt from "bcryptjs";
import { prisma } from "@/lib/prisma";
import { checkRateLimit } from "@/lib/rate-limit";
import { authConfig } from "@/auth.config";
import { deriveSessionLabel } from "@/lib/session-label";
import { createUserSession, isSessionRevoked } from "@/lib/session-handlers";

const SESSION_RECHECK_INTERVAL_MS = 5 * 60 * 1000;

export const { handlers, auth, signIn, signOut } = NextAuth({
  ...authConfig,
  providers: [
    Credentials({
      name: "credentials",
      credentials: {
        email: { label: "Email", type: "email" },
        password: { label: "Password", type: "password" },
      },
      authorize: async (credentials, request) => {
        const email = credentials?.email as string | undefined;
        const password = credentials?.password as string | undefined;
        if (!email || !password) return null;

        const { allowed } = await checkRateLimit(`login:${email.toLowerCase()}`, {
          limit: 5,
          windowMs: 10 * 60 * 1000,
        });
        if (!allowed) return null;

        const user = await prisma.user.findUnique({ where: { email } });
        if (!user) return null;

        const valid = await bcrypt.compare(password, user.passwordHash);
        if (!valid) return null;

        const membership = await prisma.organizationMembership.findUnique({
          where: { userId: user.id },
          include: { organization: { select: { id: true, name: true } } },
        });

        const label = deriveSessionLabel(request.headers.get("user-agent"));
        const userSession = await createUserSession(user.id, label);

        return {
          id: user.id,
          name: user.name,
          email: user.email,
          role: user.role,
          organizationId: membership?.organizationId,
          organizationRole: membership?.role,
          organizationName: membership?.organization.name,
          sessionId: userSession.id,
        };
      },
    }),
  ],
  callbacks: {
    ...authConfig.callbacks,
    // Runs the shared jwt callback first (copies id/role/org/session fields
    // off `user` at sign-in), then handles two Node-only, Prisma-requiring
    // concerns kept out of auth.config.ts (Edge-safe base):
    // 1. On an explicit client-side useSession().update() call (invite-
    //    accept, remove-member), re-reads the membership so the JWT
    //    reflects an org change without a re-login.
    // 2. Periodically (see SESSION_RECHECK_INTERVAL_MS) checks whether this
    //    login was remotely revoked from /account/sessions. Deliberately
    //    NOT checked on every request — that would add a DB round trip to
    //    every authenticated request in the app; a revoked session takes up
    //    to the recheck interval to actually sign out, which is an
    //    accepted tradeoff for a self-service "sign out my old laptop"
    //    feature, not a security-critical instant-kill switch.
    async jwt(params) {
      const token = await authConfig.callbacks!.jwt!(params);
      if (!token) return token;

      if (params.trigger === "update" && token.id) {
        const membership = await prisma.organizationMembership.findUnique({
          where: { userId: token.id as string },
          include: { organization: { select: { id: true, name: true } } },
        });
        if (membership) {
          token.organizationId = membership.organizationId;
          token.organizationRole = membership.role;
          token.organizationName = membership.organization.name;
        }
      }

      if (typeof token.sessionId === "string") {
        const checkedAt = (token.sessionRevocationCheckedAt as number | undefined) ?? 0;
        if (Date.now() - checkedAt > SESSION_RECHECK_INTERVAL_MS) {
          try {
            if (await isSessionRevoked(token.sessionId)) {
              // NextAuth clears the session cookie server-side when the jwt
              // callback returns null — this is the actual "sign this
              // device out" mechanism, not a UI-only state.
              return null;
            }
            token.sessionRevocationCheckedAt = Date.now();
          } catch (err) {
            // Fail OPEN: a transient DB blip must not lock every signed-in
            // user out of the whole app. Still advance the checkpoint so a
            // sustained outage doesn't turn into a failing query on every
            // single request — degrades to "revocation doesn't work until
            // the DB is back," never to "nobody can use the app."
            console.error("[auth] session revocation check failed, failing open", err);
            token.sessionRevocationCheckedAt = Date.now();
          }
        }
      }

      return token;
    },
  },
});
