import type { DefaultSession } from "next-auth";

declare module "next-auth" {
  interface Session {
    // A session-level property (not user.*) — the id of this specific login,
    // echoed here so the account/sessions page can tell "which row is me."
    sessionId?: string;
    user: {
      id: string;
      role: string;
      organizationId: string;
      organizationRole: string;
      organizationName: string;
      // VENDOR sessions only (see the vendor-magic-link provider in auth.ts
      // and src/lib/vendor-auth.ts) — undefined for every staff/buyer
      // session, and never set to anything else for a vendor session, so a
      // vendor-scoped check (`role === "VENDOR" && vendorId === params.id`)
      // can never be satisfied by an unrelated session type.
      vendorId?: string;
      eventId?: string;
      // SPONSOR sessions only (see the sponsor-magic-link provider in
      // auth.ts and src/lib/sponsor-auth.ts) — same isolation discipline as
      // vendorId above.
      sponsorId?: string;
    } & DefaultSession["user"];
  }
}

declare module "next-auth/jwt" {
  interface JWT {
    sessionId?: string;
    // Epoch ms — when the periodic revocation recheck in auth.ts's jwt()
    // callback last ran, so that check stays a pure token-inspection on the
    // fast path instead of a DB read on every request.
    sessionRevocationCheckedAt?: number;
  }
}
