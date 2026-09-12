import { describe, expect, it } from "vitest";
import { createHash, randomBytes } from "crypto";
import { prisma } from "@/lib/prisma";
import { createTestEvent, createTestOrganization, createTestSponsor } from "@/lib/test-fixtures";
import { generateSponsorMagicLink, consumeSponsorMagicLinkToken } from "@/lib/sponsor-auth";

async function newEventWithSponsor() {
  const organization = await createTestOrganization();
  const event = await createTestEvent(organization.id);
  const sponsor = await createTestSponsor(event.id);
  return { event, sponsor };
}

describe("generateSponsorMagicLink / consumeSponsorMagicLinkToken", () => {
  it("issues a token that consumeSponsorMagicLinkToken accepts exactly once", async () => {
    const { event, sponsor } = await newEventWithSponsor();

    const rawToken = await generateSponsorMagicLink(sponsor.id);
    expect(rawToken).toMatch(/^[0-9a-f]{64}$/); // randomBytes(32).toString("hex")

    const first = await consumeSponsorMagicLinkToken(rawToken);
    expect(first.ok).toBe(true);
    if (first.ok) {
      expect(first.sponsor.id).toBe(sponsor.id);
      expect(first.sponsor.eventId).toBe(event.id);
    }

    // First use "whichever comes first" — a second attempt with the same
    // raw token must fail even though 24h hasn't elapsed.
    const second = await consumeSponsorMagicLinkToken(rawToken);
    expect(second.ok).toBe(false);
  });

  it("rejects a token past its 24h expiry, even if never used", async () => {
    const { sponsor } = await newEventWithSponsor();

    // Bypass generateSponsorMagicLink's own 24h default to simulate an
    // already-expired, still-unused token.
    const rawToken = randomBytes(32).toString("hex");
    const tokenHash = createHash("sha256").update(rawToken).digest("hex");
    await prisma.sponsorMagicLinkToken.create({
      data: { tokenHash, sponsorId: sponsor.id, expiresAt: new Date(Date.now() - 1000) },
    });

    const result = await consumeSponsorMagicLinkToken(rawToken);
    expect(result.ok).toBe(false);
  });

  it("rejects a garbage token that was never issued", async () => {
    const result = await consumeSponsorMagicLinkToken("not-a-real-token");
    expect(result.ok).toBe(false);
  });
});
