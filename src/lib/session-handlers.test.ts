import { describe, expect, it } from "vitest";
import { prisma } from "@/lib/prisma";
import { createTestUser } from "@/lib/test-fixtures";
import {
  createUserSession,
  isSessionRevoked,
  revokeUserSessionById,
  revokeAllOtherUserSessions,
  listUserSessions,
} from "@/lib/session-handlers";

describe("createUserSession", () => {
  it("creates a row with the given label, truncated to 80 chars", async () => {
    const user = await createTestUser();
    const session = await createUserSession(user.id, "Chrome on Windows");
    expect(session.userId).toBe(user.id);
    expect(session.label).toBe("Chrome on Windows");
    expect(session.revokedAt).toBeNull();

    const long = await createUserSession(user.id, "x".repeat(200));
    expect(long.label).toHaveLength(80);
  });
});

describe("isSessionRevoked", () => {
  it("returns false and bumps lastSeenAt for an active session", async () => {
    const user = await createTestUser();
    const session = await createUserSession(user.id, "Chrome on Windows");
    const before = session.lastSeenAt;

    const revoked = await isSessionRevoked(session.id);

    expect(revoked).toBe(false);
    const updated = await prisma.userSession.findUniqueOrThrow({ where: { id: session.id } });
    expect(updated.lastSeenAt.getTime()).toBeGreaterThanOrEqual(before.getTime());
  });

  it("returns true for a revoked session and does not bump lastSeenAt", async () => {
    const user = await createTestUser();
    const owner = await createTestUser();
    const session = await createUserSession(user.id, "Chrome on Windows");
    await revokeUserSessionById(user.id, session.id, owner.id);
    const beforeCheck = await prisma.userSession.findUniqueOrThrow({ where: { id: session.id } });

    const revoked = await isSessionRevoked(session.id);

    expect(revoked).toBe(true);
    const afterCheck = await prisma.userSession.findUniqueOrThrow({ where: { id: session.id } });
    expect(afterCheck.lastSeenAt).toEqual(beforeCheck.lastSeenAt);
  });

  it("returns true for a nonexistent session id", async () => {
    expect(await isSessionRevoked("does-not-exist")).toBe(true);
  });
});

describe("revokeUserSessionById", () => {
  it("sets revokedAt/revokedByUserId", async () => {
    const user = await createTestUser();
    const revoked = await revokeUserSessionById(
      user.id,
      (await createUserSession(user.id, "Chrome on Windows")).id,
      user.id
    );
    expect(revoked.revokedAt).not.toBeNull();
    expect(revoked.revokedByUserId).toBe(user.id);
  });

  it("throws when the session belongs to a different user", async () => {
    const owner = await createTestUser();
    const stranger = await createTestUser();
    const session = await createUserSession(owner.id, "Chrome on Windows");

    await expect(revokeUserSessionById(stranger.id, session.id, stranger.id)).rejects.toThrow();
  });
});

describe("revokeAllOtherUserSessions", () => {
  it("revokes every other active session for that user, leaves the current one and another user's sessions untouched", async () => {
    const user = await createTestUser();
    const otherUser = await createTestUser();
    const current = await createUserSession(user.id, "Current device");
    const other1 = await createUserSession(user.id, "Old laptop");
    const other2 = await createUserSession(user.id, "Old phone");
    const strangerSession = await createUserSession(otherUser.id, "Stranger's device");

    await revokeAllOtherUserSessions(user.id, current.id);

    const currentAfter = await prisma.userSession.findUniqueOrThrow({ where: { id: current.id } });
    const other1After = await prisma.userSession.findUniqueOrThrow({ where: { id: other1.id } });
    const other2After = await prisma.userSession.findUniqueOrThrow({ where: { id: other2.id } });
    const strangerAfter = await prisma.userSession.findUniqueOrThrow({ where: { id: strangerSession.id } });

    expect(currentAfter.revokedAt).toBeNull();
    expect(other1After.revokedAt).not.toBeNull();
    expect(other2After.revokedAt).not.toBeNull();
    expect(strangerAfter.revokedAt).toBeNull();
  });
});

describe("listUserSessions", () => {
  it("returns only this user's active (non-revoked) sessions", async () => {
    const user = await createTestUser();
    const otherUser = await createTestUser();
    const active = await createUserSession(user.id, "Active session");
    const revoked = await createUserSession(user.id, "Revoked session");
    await revokeUserSessionById(user.id, revoked.id, user.id);
    await createUserSession(otherUser.id, "Someone else's session");

    const sessions = await listUserSessions(user.id);

    expect(sessions.map((s) => s.id)).toEqual([active.id]);
  });
});
