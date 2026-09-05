import { describe, expect, it } from "vitest";
import { prisma } from "@/lib/prisma";
import { createTestOrganization, createTestUser, addMembership, createTestEvent, createPaidOrder } from "@/lib/test-fixtures";
import { findAttendeeCandidates, provisionWristband } from "@/lib/wristband-handlers";

async function newOrganizer() {
  const user = await createTestUser();
  const organization = await createTestOrganization();
  await addMembership(organization.id, user.id, "OWNER");
  return { user, organizationId: organization.id };
}

function uniqueUid() {
  return `04:${Date.now().toString(16)}:${Math.random().toString(16).slice(2, 10)}`;
}

describe("provisionWristband", () => {
  it("links both the wallet and an existing PAID ticket, sharing the same nfcUid", async () => {
    const { organizationId } = await newOrganizer();
    const buyer = await createTestUser();
    const { event, order } = await createPaidOrder(organizationId, buyer.id, 100000);
    const uid = uniqueUid();

    const result = await provisionWristband(organizationId, event.id, uid, "actor-1", "Actor One", { userId: buyer.id });

    expect(result.wallet.ownerUserId).toBe(buyer.id);
    expect(result.ticket?.id).toBe(order.tickets[0].id);

    const rows = await prisma.credential.findMany({ where: { nfcUid: uid, status: "ACTIVE" } });
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.walletId).filter(Boolean)).toHaveLength(1);
    expect(rows.map((r) => r.ticketId).filter(Boolean)).toHaveLength(1);
  });

  it("succeeds wallet-only when the attendee has no PAID/NEEDS_REVIEW ticket for this event", async () => {
    const { organizationId } = await newOrganizer();
    const attendee = await createTestUser();
    const event = await createTestEvent(organizationId);
    const uid = uniqueUid();

    const result = await provisionWristband(organizationId, event.id, uid, "actor-1", "Actor One", {
      email: attendee.email,
      name: attendee.name,
    });

    expect(result.wallet.ownerUserId).toBe(attendee.id);
    expect(result.ticket).toBeNull();

    const rows = await prisma.credential.findMany({ where: { nfcUid: uid, status: "ACTIVE" } });
    expect(rows).toHaveLength(1);
    expect(rows[0].walletId).toBe(result.wallet.id);
  });

  it("links the ticket's current transfer-holder, not the original buyer", async () => {
    const { organizationId } = await newOrganizer();
    const originalBuyer = await createTestUser();
    const holder = await createTestUser();
    const { event, order } = await createPaidOrder(organizationId, originalBuyer.id, 100000);
    await prisma.ticket.update({ where: { id: order.tickets[0].id }, data: { currentHolderUserId: holder.id } });
    const uid = uniqueUid();

    const result = await provisionWristband(organizationId, event.id, uid, "actor-1", "Actor One", { userId: holder.id });

    expect(result.ticket?.id).toBe(order.tickets[0].id);
    expect(result.wallet.ownerUserId).toBe(holder.id);
  });

  it("creates a real User with a working password hash for a brand-new email", async () => {
    const { organizationId } = await newOrganizer();
    const event = await createTestEvent(organizationId);
    const email = `walkup-${Date.now()}@test.local`;

    const result = await provisionWristband(organizationId, event.id, uniqueUid(), "actor-1", "Actor One", {
      email,
      name: "Walk-up Attendee",
    });

    const stored = await prisma.user.findUniqueOrThrow({ where: { id: result.user.id } });
    expect(stored.passwordHash).toBeTruthy();
    expect(stored.passwordHash).not.toBe(email);
  });

  it("reuses an existing User by email rather than creating a duplicate", async () => {
    const { organizationId } = await newOrganizer();
    const existing = await createTestUser();
    const event = await createTestEvent(organizationId);

    const result = await provisionWristband(organizationId, event.id, uniqueUid(), "actor-1", "Actor One", {
      email: existing.email,
      name: "Ignored",
    });

    expect(result.user.id).toBe(existing.id);
    expect(await prisma.user.count({ where: { email: existing.email } })).toBe(1);
  });

  it("is idempotent-ish per attendee — re-provisioning a NEW tag supersedes their old credential(s)", async () => {
    const { organizationId } = await newOrganizer();
    const attendee = await createTestUser();
    const event = await createTestEvent(organizationId);

    const first = await provisionWristband(organizationId, event.id, uniqueUid(), "actor-1", "Actor One", { userId: attendee.id });
    const second = await provisionWristband(organizationId, event.id, uniqueUid(), "actor-1", "Actor One", { userId: attendee.id });

    expect(first.wallet.id).toBe(second.wallet.id); // same wallet, one per user per event
    const history = await prisma.credential.findMany({ where: { walletId: first.wallet.id }, orderBy: { createdAt: "asc" } });
    expect(history).toHaveLength(2);
    expect(history[0].status).toBe("SUPERSEDED");
    expect(history[0].supersededAt).not.toBeNull();
    expect(history[1].status).toBe("ACTIVE");
  });

  it("cross-attendee tag reuse: re-provisioning a uid previously bound to A, now for B, supersedes A's row(s) too", async () => {
    const { organizationId } = await newOrganizer();
    const attendeeA = await createTestUser();
    const attendeeB = await createTestUser();
    const event = await createTestEvent(organizationId);
    const uid = uniqueUid();

    await provisionWristband(organizationId, event.id, uid, "actor-1", "Actor One", { userId: attendeeA.id });
    const forB = await provisionWristband(organizationId, event.id, uid, "actor-1", "Actor One", { userId: attendeeB.id });

    const activeForUid = await prisma.credential.findMany({ where: { nfcUid: uid, status: "ACTIVE" } });
    expect(activeForUid).toHaveLength(1);
    expect(activeForUid[0].walletId).toBe(forB.wallet.id);
  });

  it("throws when the event belongs to a different organization", async () => {
    const { organizationId: organizationIdA } = await newOrganizer();
    const { organizationId: organizationIdB } = await newOrganizer();
    const attendee = await createTestUser();
    const event = await createTestEvent(organizationIdA);

    await expect(
      provisionWristband(organizationIdB, event.id, uniqueUid(), "actor-1", "Actor One", { userId: attendee.id })
    ).rejects.toThrow();
  });
});

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
