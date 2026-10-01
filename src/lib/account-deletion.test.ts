import { describe, it, expect } from "vitest";
import { prisma } from "@/lib/prisma";
import { deleteOwnAccount, getAccountDeletionBlock } from "@/lib/account-deletion";
import {
  createTestUser,
  createTestOrganization,
  addMembership,
  createTestEvent,
  createPaidOrder,
} from "@/lib/test-fixtures";

const SENTINEL_EMAIL = "deleted-user@chaap.internal";

describe("deleteOwnAccount", () => {
  it("anonymizes the User row and removes sessions / password reset tokens", async () => {
    const user = await createTestUser({ name: "Amina Hassan" });
    await prisma.user.update({ where: { id: user.id }, data: { phone: "+255700000001" } });
    const org = await createTestOrganization();
    await addMembership(org.id, user.id, "STAFF");

    await prisma.userSession.create({ data: { userId: user.id, label: "Chrome on Mac" } });
    await prisma.passwordResetToken.create({
      data: { userId: user.id, tokenHash: `hash-${user.id}`, expiresAt: new Date(Date.now() + 3600000) },
    });

    await deleteOwnAccount(user.id);

    const updated = await prisma.user.findUniqueOrThrow({ where: { id: user.id } });
    expect(updated.name).toBe("Deleted User");
    expect(updated.email).not.toBe(user.email);
    expect(updated.email).toContain("deleted-");
    expect(updated.phone).toBeNull();
    expect(updated.passwordHash).not.toBe("unused-in-tests");

    expect(await prisma.userSession.count({ where: { userId: user.id } })).toBe(0);
    expect(await prisma.passwordResetToken.count({ where: { userId: user.id } })).toBe(0);
  });

  it("repoints Orders and transferred Tickets' current holder to one shared sentinel across multiple deletions", async () => {
    const orgA = await createTestOrganization();
    const buyerA = await createTestUser();
    await addMembership(orgA.id, buyerA.id, "STAFF");
    const { order: orderA } = await createPaidOrder(orgA.id, buyerA.id, 50000);

    const orgB = await createTestOrganization();
    const buyerB = await createTestUser();
    await addMembership(orgB.id, buyerB.id, "STAFF");
    const { order: orderB } = await createPaidOrder(orgB.id, buyerB.id, 50000);
    const ticketB = await prisma.ticket.findFirstOrThrow({ where: { orderId: orderB.id } });

    // Simulate buyerB's ticket having been accepted by a different holder
    // (a TicketTransfer recipient), so deleting that HOLDER's account is
    // exercised too, independently of deleting the order's own buyer.
    const holder = await createTestUser();
    await prisma.ticket.update({ where: { id: ticketB.id }, data: { currentHolderUserId: holder.id } });

    await deleteOwnAccount(buyerA.id);
    await deleteOwnAccount(holder.id);

    const sentinel = await prisma.user.findUniqueOrThrow({ where: { email: SENTINEL_EMAIL } });
    expect(sentinel.name).toBe("Deleted User");

    const updatedOrderA = await prisma.order.findUniqueOrThrow({ where: { id: orderA.id } });
    expect(updatedOrderA.userId).toBe(sentinel.id);

    const updatedTicketB = await prisma.ticket.findUniqueOrThrow({ where: { id: ticketB.id } });
    expect(updatedTicketB.currentHolderUserId).toBe(sentinel.id);

    // orderB's own buyer was never deleted, so it keeps pointing at buyerB.
    const untouchedOrderB = await prisma.order.findUniqueOrThrow({ where: { id: orderB.id } });
    expect(untouchedOrderB.userId).toBe(buyerB.id);

    // Only one sentinel row exists no matter how many accounts get deleted.
    expect(await prisma.user.count({ where: { email: SENTINEL_EMAIL } })).toBe(1);
  });

  it("blocks deletion when the user is the sole OWNER of an organization with a LIVE upcoming event", async () => {
    const org = await createTestOrganization();
    const owner = await createTestUser();
    await addMembership(org.id, owner.id, "OWNER");
    await createTestEvent(org.id); // default startsAt is now + 1 day, status LIVE

    const block = await getAccountDeletionBlock(owner.id);
    expect(block).not.toBeNull();

    await expect(deleteOwnAccount(owner.id)).rejects.toThrow();

    const untouched = await prisma.user.findUniqueOrThrow({ where: { id: owner.id } });
    expect(untouched.name).not.toBe("Deleted User");
  });

  it("allows deletion once the organization's only events have concluded or been cancelled", async () => {
    const org = await createTestOrganization();
    const owner = await createTestUser();
    await addMembership(org.id, owner.id, "OWNER");

    await prisma.event.create({
      data: {
        slug: `past-${Date.now()}`,
        title: "Concluded Event",
        description: "",
        category: "Music",
        venue: "Venue",
        city: "Dar es Salaam",
        startsAt: new Date(Date.now() - 2 * 86400000),
        endsAt: new Date(Date.now() - 86400000),
        imageUrl: "https://example.com/x.jpg",
        organizationId: org.id,
        status: "LIVE",
      },
    });
    await prisma.event.create({
      data: {
        slug: `cancelled-${Date.now()}`,
        title: "Cancelled Event",
        description: "",
        category: "Music",
        venue: "Venue",
        city: "Dar es Salaam",
        startsAt: new Date(Date.now() + 86400000),
        imageUrl: "https://example.com/x.jpg",
        organizationId: org.id,
        status: "CANCELLED",
      },
    });

    expect(await getAccountDeletionBlock(owner.id)).toBeNull();
    await deleteOwnAccount(owner.id);

    const updated = await prisma.user.findUniqueOrThrow({ where: { id: owner.id } });
    expect(updated.name).toBe("Deleted User");
  });

  it("never blocks a STAFF member, even if their organization has an upcoming event", async () => {
    const org = await createTestOrganization();
    const owner = await createTestUser();
    await addMembership(org.id, owner.id, "OWNER");
    const staff = await createTestUser();
    await addMembership(org.id, staff.id, "STAFF");
    await createTestEvent(org.id);

    expect(await getAccountDeletionBlock(staff.id)).toBeNull();
    await deleteOwnAccount(staff.id);

    const updated = await prisma.user.findUniqueOrThrow({ where: { id: staff.id } });
    expect(updated.name).toBe("Deleted User");
  });

  it("logs an ACCOUNT_DELETED audit entry scrubbed of the real name/email", async () => {
    const org = await createTestOrganization();
    const user = await createTestUser({ name: "Juma Mwangi", email: `juma-${Date.now()}@test.local` });
    await addMembership(org.id, user.id, "STAFF");

    await deleteOwnAccount(user.id);

    const entry = await prisma.auditLog.findFirstOrThrow({
      where: { organizationId: org.id, action: "ACCOUNT_DELETED", actorUserId: user.id },
    });
    expect(entry.actorName).toBe("Deleted User");
    expect(entry.summary).not.toContain("Juma");
    expect(entry.summary).not.toContain(user.email);
  });
});
