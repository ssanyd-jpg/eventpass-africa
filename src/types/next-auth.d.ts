import type { DefaultSession } from "next-auth";

declare module "next-auth" {
  interface Session {
    user: {
      id: string;
      role: string;
      organizationId: string;
      organizationRole: string;
      organizationName: string;
    } & DefaultSession["user"];
  }
}
