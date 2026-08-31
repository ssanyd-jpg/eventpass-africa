import { prisma } from "@/lib/prisma";

// Extracted for the same reason device-handlers.ts is separate from its
// routes: testable without HTTP/auth plumbing. Deliberately unrelated to
// device-handlers.ts — Device (per-org-per-browser install) and UserSession
// (per-login) are different concepts that happen to sound similar.

export async function createUserSession(userId: string, label: string) {
  return prisma.userSession.create({ data: { userId, label: label.slice(0, 80) } });
}

// Called ONLY from src/auth.ts's Node-only jwt() override — never from
// auth.config.ts (Prisma can't run in the Edge middleware runtime).
// Combines the revocation lookup and the lastSeenAt bump into one round
// trip, since avoiding extra DB hits is the whole point of the periodic-
// check design in the jwt() callback.
export async function isSessionRevoked(sessionId: string): Promise<boolean> {
  const session = await prisma.userSession.findUnique({ where: { id: sessionId } });
  if (!session || session.revokedAt) return true; // missing row = treat as revoked
  await prisma.userSession.update({ where: { id: sessionId }, data: { lastSeenAt: new Date() } });
  return false;
}

async function requireOwnSession(userId: string, id: string) {
  const session = await prisma.userSession.findUnique({ where: { id } });
  if (!session || session.userId !== userId) {
    throw new Error("Session not found.");
  }
  return session;
}

export async function revokeUserSessionById(userId: string, id: string, revokedByUserId: string) {
  await requireOwnSession(userId, id);
  return prisma.userSession.update({ where: { id }, data: { revokedAt: new Date(), revokedByUserId } });
}

export async function revokeAllOtherUserSessions(userId: string, currentSessionId: string) {
  return prisma.userSession.updateMany({
    where: { userId, id: { not: currentSessionId }, revokedAt: null },
    data: { revokedAt: new Date(), revokedByUserId: userId },
  });
}

export async function listUserSessions(userId: string) {
  return prisma.userSession.findMany({ where: { userId, revokedAt: null }, orderBy: { lastSeenAt: "desc" } });
}
