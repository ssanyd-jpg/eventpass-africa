import NextAuth from "next-auth";
import Credentials from "next-auth/providers/credentials";
import bcrypt from "bcryptjs";
import { prisma } from "@/lib/prisma";
import { checkRateLimit } from "@/lib/rate-limit";
import { authConfig } from "@/auth.config";

export const { handlers, auth, signIn, signOut } = NextAuth({
  ...authConfig,
  providers: [
    Credentials({
      name: "credentials",
      credentials: {
        email: { label: "Email", type: "email" },
        password: { label: "Password", type: "password" },
      },
      authorize: async (credentials) => {
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

        return {
          id: user.id,
          name: user.name,
          email: user.email,
          role: user.role,
          organizationId: membership?.organizationId,
          organizationRole: membership?.role,
          organizationName: membership?.organization.name,
        };
      },
    }),
  ],
  callbacks: {
    ...authConfig.callbacks,
    // Runs the shared jwt callback first (copies id/role/org fields off
    // `user` at sign-in), then — only on an explicit client-side
    // useSession().update() call (invite-accept, remove-member) — re-reads
    // the membership so the JWT reflects an org change without a re-login.
    // Kept out of auth.config.ts (Edge-safe base) since it needs Prisma.
    async jwt(params) {
      const token = await authConfig.callbacks!.jwt!(params);
      if (token && params.trigger === "update" && token.id) {
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
      return token;
    },
  },
});
