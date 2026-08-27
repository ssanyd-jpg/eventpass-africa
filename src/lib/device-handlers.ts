import { prisma } from "@/lib/prisma";

// Extracted from the sync routes for the same reason sync-handlers.ts and
// settlement-handlers.ts are separate from theirs: testable without an HTTP
// request/response round-trip.

export type DeviceCheckResult = { ok: true } | { ok: false; reason: "DEVICE_REVOKED" };

// Called on every sync/push and sync/pull request that carries an
// X-Device-Id header. Rejects before tracking if the device has been
// revoked — a revoked device must not get its lastSeenAt bumped by the very
// request it's being blocked from making.
export async function checkAndTrackDevice(
  organizationId: string,
  deviceId: string,
  userId: string,
  userName: string
): Promise<DeviceCheckResult> {
  const existing = await prisma.device.findUnique({
    where: { organizationId_deviceId: { organizationId, deviceId } },
  });
  if (existing?.revokedAt) {
    return { ok: false, reason: "DEVICE_REVOKED" };
  }
  await prisma.device.upsert({
    where: { organizationId_deviceId: { organizationId, deviceId } },
    create: { organizationId, deviceId, lastSeenByUserId: userId, lastSeenByName: userName },
    update: { lastSeenAt: new Date(), lastSeenByUserId: userId, lastSeenByName: userName },
  });
  return { ok: true };
}

async function requireOwnDevice(organizationId: string, id: string) {
  const device = await prisma.device.findUnique({ where: { id } });
  if (!device || device.organizationId !== organizationId) {
    throw new Error("Device not found.");
  }
  return device;
}

export async function revokeDeviceById(organizationId: string, id: string, revokedByUserId: string) {
  await requireOwnDevice(organizationId, id);
  return prisma.device.update({ where: { id }, data: { revokedAt: new Date(), revokedByUserId } });
}

export async function reactivateDeviceById(organizationId: string, id: string) {
  await requireOwnDevice(organizationId, id);
  return prisma.device.update({ where: { id }, data: { revokedAt: null, revokedByUserId: null } });
}

export async function renameDeviceById(organizationId: string, id: string, label: string) {
  await requireOwnDevice(organizationId, id);
  return prisma.device.update({ where: { id }, data: { label: label.slice(0, 60) } });
}
