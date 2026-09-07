import { describe, expect, it } from "vitest";
import { createTestOrganization, createTestUser, addMembership, createTestEvent, createPaidOrder } from "@/lib/test-fixtures";
import { findAttendeeCandidates } from "@/lib/wristband-handlers";

async function newOrganizer() {
  const user = await createTestUser();
  const organization = await createTestOrganization();
  await addMembership(organization.id, user.id, "OWNER");
  return { user, organizationId: organization.id };
}

describe("findAttendeeCandidates", () => {
  it("finds an attendee by their ticket code", async () => {
    const { organizationId } = await newOrganizer();
    const buyer = await createTestUser();
    const { event, order } = await createPaidOrder(organizationId, buyer.id, 100000);

    const results = await findAttendeeCandidates(organizationId, event.id, order.tickets[0].code);
    expect(results).toHaveLength(1);
    expect(results[0].id).toBe(buyer.id);
  });

  it("finds an attendee by email substring, scoped to this organizer's own events", async () => {
    const { organizationId } = await newOrganizer();
    const buyer = await createTestUser({ email: `findme-${Date.now()}@test.local` });
    const { event } = await createPaidOrder(organizationId, buyer.id, 100000);

    const results = await findAttendeeCandidates(organizationId, event.id, "findme-");
    expect(results.some((r) => r.id === buyer.id)).toBe(true);
  });

  it("does not surface a user who has never bought anything at this organizer's events", async () => {
    const { organizationId } = await newOrganizer();
    const event = await createTestEvent(organizationId);
    const stranger = await createTestUser({ email: `stranger-${Date.now()}@test.local` });

    const results = await findAttendeeCandidates(organizationId, event.id, "stranger-");
    expect(results.some((r) => r.id === stranger.id)).toBe(false);
  });
});
