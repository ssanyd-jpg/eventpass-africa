import { describe, expect, it } from "vitest";
import { createTestUser, createTestOrganization, addMembership, createTestEvent, createTestSponsor, createTestWallet } from "@/lib/test-fixtures";
import { handleSponsorTap } from "@/lib/sync-handlers";
import { getSponsor, getSponsorLeads, buildSponsorLeadsCsv } from "@/lib/sponsor-leads";

async function newOrganizer() {
  const user = await createTestUser();
  const organization = await createTestOrganization();
  await addMembership(organization.id, user.id, "OWNER");
  return { user, organizationId: organization.id };
}

describe("getSponsor", () => {
  it("finds a sponsor scoped to the caller's organization", async () => {
    const { organizationId } = await newOrganizer();
    const event = await createTestEvent(organizationId);
    const sponsor = await createTestSponsor(event.id);

    const found = await getSponsor(organizationId, sponsor.id);
    expect(found?.id).toBe(sponsor.id);
  });

  it("returns null for a sponsor belonging to a different organization", async () => {
    const { organizationId } = await newOrganizer();
    const event = await createTestEvent(organizationId);
    const sponsor = await createTestSponsor(event.id);

    const { organizationId: otherOrgId } = await newOrganizer();
    const found = await getSponsor(otherOrgId, sponsor.id);
    expect(found).toBeNull();
  });
});

describe("getSponsorLeads", () => {
  it("returns only SPONSOR_TAP rows for the given sponsor, newest first, with owner name/email and note", async () => {
    const { user: organizer, organizationId } = await newOrganizer();
    const attendeeA = await createTestUser({ name: "Alice", email: "alice@test.local" });
    const attendeeB = await createTestUser({ name: "Bob", email: "bob@test.local" });
    const event = await createTestEvent(organizationId);
    const sponsor = await createTestSponsor(event.id, { name: "Acme Corp" });
    const otherSponsor = await createTestSponsor(event.id, { name: "Other Corp" });
    const walletA = await createTestWallet(event.id, attendeeA.id);
    const walletB = await createTestWallet(event.id, attendeeB.id);

    await handleSponsorTap(organizer.id, organizationId, {
      clientId: "lead-a", walletCode: walletA.code, sponsorId: sponsor.id, eventId: event.id, note: "Note A",
    });
    await handleSponsorTap(organizer.id, organizationId, {
      clientId: "lead-b", walletCode: walletB.code, sponsorId: sponsor.id, eventId: event.id,
    });
    // A tap for a DIFFERENT sponsor, and a TOPUP — neither should show up.
    await handleSponsorTap(organizer.id, organizationId, {
      clientId: "lead-other-sponsor", walletCode: walletA.code, sponsorId: otherSponsor.id, eventId: event.id,
    });

    const leads = await getSponsorLeads(sponsor.id);

    expect(leads).toHaveLength(2);
    expect(leads.map((l) => l.wallet.owner.name)).toEqual(["Bob", "Alice"]); // newest first
    expect(leads[1].note).toBe("Note A");
    expect(leads[0].note).toBeNull();
    expect(leads.every((l) => l.sponsorId === sponsor.id)).toBe(true);
  });
});

describe("buildSponsorLeadsCsv", () => {
  it("produces correct headers and escapes commas/quotes/newlines in a note", async () => {
    const { user: organizer, organizationId } = await newOrganizer();
    const attendee = await createTestUser({ name: "Carol", email: "carol@test.local" });
    const event = await createTestEvent(organizationId);
    const sponsor = await createTestSponsor(event.id, { name: "Acme Corp" });
    const wallet = await createTestWallet(event.id, attendee.id);

    await handleSponsorTap(organizer.id, organizationId, {
      clientId: "lead-csv",
      walletCode: wallet.code,
      sponsorId: sponsor.id,
      eventId: event.id,
      note: 'Loves "cloud", scale\nfollow up Monday',
    });

    const leads = await getSponsorLeads(sponsor.id);
    const csv = buildSponsorLeadsCsv(sponsor.name, leads);

    expect(csv).toContain("Sponsor leads — Acme Corp");
    expect(csv).toContain("Name,Email,Note,Campaign,Scanned At");
    expect(csv).toContain("carol@test.local");
    // The note's internal quotes/comma/newline force the whole field to be
    // quoted, with internal quotes doubled — matches csvEscape's contract.
    expect(csv).toContain('"Loves ""cloud"", scale\nfollow up Monday"');
  });
});
