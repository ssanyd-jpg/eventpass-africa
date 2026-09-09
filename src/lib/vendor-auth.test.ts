import { describe, expect, it } from "vitest";
import { createHash, randomBytes } from "crypto";
import { prisma } from "@/lib/prisma";
import { createTestEvent, createTestOrganization, createTestVendor } from "@/lib/test-fixtures";
import { generateVendorMagicLink, consumeVendorMagicLinkToken } from "@/lib/vendor-auth";

async function newEventWithVendor(overrides: Partial<{ status: string }> = {}) {
  const organization = await createTestOrganization();
  const event = await createTestEvent(organization.id);
  const vendor = await createTestVendor(event.id, { status: overrides.status ?? "APPROVED" });
  return { event, vendor };
}

describe("generateVendorMagicLink / consumeVendorMagicLinkToken", () => {
  it("issues a token that consumeVendorMagicLinkToken accepts exactly once", async () => {
    const { event, vendor } = await newEventWithVendor();

    const rawToken = await generateVendorMagicLink(vendor.id);
    expect(rawToken).toMatch(/^[0-9a-f]{64}$/); // randomBytes(32).toString("hex")

    const first = await consumeVendorMagicLinkToken(rawToken);
    expect(first.ok).toBe(true);
    if (first.ok) {
      expect(first.vendor.id).toBe(vendor.id);
      expect(first.vendor.eventId).toBe(event.id);
    }

    // First use "whichever comes first" — a second attempt with the same
    // raw token must fail even though 24h hasn't elapsed.
    const second = await consumeVendorMagicLinkToken(rawToken);
    expect(second.ok).toBe(false);
  });

  it("rejects a token past its 24h expiry, even if never used", async () => {
    const { vendor } = await newEventWithVendor();

    // Bypass generateVendorMagicLink's own 24h default to simulate an
    // already-expired, still-unused token.
    const rawToken = randomBytes(32).toString("hex");
    const tokenHash = createHash("sha256").update(rawToken).digest("hex");
    await prisma.vendorMagicLinkToken.create({
      data: { tokenHash, vendorId: vendor.id, expiresAt: new Date(Date.now() - 1000) },
    });

    const result = await consumeVendorMagicLinkToken(rawToken);
    expect(result.ok).toBe(false);
  });

  it("rejects a token for a vendor that is no longer APPROVED", async () => {
    const { vendor } = await newEventWithVendor({ status: "REJECTED" });

    const rawToken = await generateVendorMagicLink(vendor.id);
    const result = await consumeVendorMagicLinkToken(rawToken);
    expect(result.ok).toBe(false);
  });

  it("rejects a garbage token that was never issued", async () => {
    const result = await consumeVendorMagicLinkToken("not-a-real-token");
    expect(result.ok).toBe(false);
  });
});
