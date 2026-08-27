import { describe, expect, it } from "vitest";
import { prisma } from "@/lib/prisma";
import { createTestOrganization, createTestUser, createTestDevice } from "@/lib/test-fixtures";
import {
  checkAndTrackDevice,
  revokeDeviceById,
  reactivateDeviceById,
  renameDeviceById,
} from "@/lib/device-handlers";

describe("checkAndTrackDevice", () => {
  it("creates a new Device row on first sight with the calling user's identity", async () => {
    const org = await createTestOrganization();
    const user = await createTestUser({ name: "Amina" });

    const result = await checkAndTrackDevice(org.id, "device-1", user.id, "Amina");

    expect(result.ok).toBe(true);
    const device = await prisma.device.findUniqueOrThrow({
      where: { organizationId_deviceId: { organizationId: org.id, deviceId: "device-1" } },
    });
    expect(device.lastSeenByUserId).toBe(user.id);
    expect(device.lastSeenByName).toBe("Amina");
    expect(device.revokedAt).toBeNull();
  });

  it("updates lastSeenAt/lastSeenByUserId/lastSeenByName on a second call from a different user", async () => {
    const org = await createTestOrganization();
    const first = await createTestUser({ name: "Amina" });
    const second = await createTestUser({ name: "Baraka" });

    await checkAndTrackDevice(org.id, "device-2", first.id, "Amina");
    // A phone handed off between two gate-crew shifts.
    await checkAndTrackDevice(org.id, "device-2", second.id, "Baraka");

    const device = await prisma.device.findUniqueOrThrow({
      where: { organizationId_deviceId: { organizationId: org.id, deviceId: "device-2" } },
    });
    expect(device.lastSeenByUserId).toBe(second.id);
    expect(device.lastSeenByName).toBe("Baraka");
  });

  it("rejects a revoked device without bumping lastSeenAt", async () => {
    const org = await createTestOrganization();
    const user = await createTestUser();
    const device = await createTestDevice(org.id, { deviceId: "device-3", revokedAt: new Date() });
    const lastSeenBefore = device.lastSeenAt;

    const result = await checkAndTrackDevice(org.id, "device-3", user.id, "Someone");

    expect(result).toEqual({ ok: false, reason: "DEVICE_REVOKED" });
    const unchanged = await prisma.device.findUniqueOrThrow({ where: { id: device.id } });
    expect(unchanged.lastSeenAt).toEqual(lastSeenBefore);
  });

  it("tracks/revokes the same literal deviceId independently across two organizations", async () => {
    const orgA = await createTestOrganization();
    const orgB = await createTestOrganization();
    const user = await createTestUser();

    await checkAndTrackDevice(orgA.id, "shared-device", user.id, "Someone");
    const deviceInA = await prisma.device.findUniqueOrThrow({
      where: { organizationId_deviceId: { organizationId: orgA.id, deviceId: "shared-device" } },
    });
    await revokeDeviceById(orgA.id, deviceInA.id, user.id);

    // Org A's device is revoked, but org B has never seen "shared-device"
    // before — first sight there should succeed cleanly.
    const resultInB = await checkAndTrackDevice(orgB.id, "shared-device", user.id, "Someone");
    expect(resultInB.ok).toBe(true);

    const resultInA = await checkAndTrackDevice(orgA.id, "shared-device", user.id, "Someone");
    expect(resultInA).toEqual({ ok: false, reason: "DEVICE_REVOKED" });
  });
});

describe("revokeDeviceById / reactivateDeviceById", () => {
  it("sets revokedAt/revokedByUserId, then clears both back to null on reactivation", async () => {
    const org = await createTestOrganization();
    const owner = await createTestUser();
    const device = await createTestDevice(org.id);

    const revoked = await revokeDeviceById(org.id, device.id, owner.id);
    expect(revoked.revokedAt).not.toBeNull();
    expect(revoked.revokedByUserId).toBe(owner.id);

    const reactivated = await reactivateDeviceById(org.id, device.id);
    expect(reactivated.revokedAt).toBeNull();
    expect(reactivated.revokedByUserId).toBeNull();
  });

  it("throws when the device belongs to a different organization", async () => {
    const orgA = await createTestOrganization();
    const orgB = await createTestOrganization();
    const owner = await createTestUser();
    const device = await createTestDevice(orgA.id);

    await expect(revokeDeviceById(orgB.id, device.id, owner.id)).rejects.toThrow();
    await expect(reactivateDeviceById(orgB.id, device.id)).rejects.toThrow();
  });
});

describe("renameDeviceById", () => {
  it("updates the label, truncated to 60 characters", async () => {
    const org = await createTestOrganization();
    const device = await createTestDevice(org.id);

    const renamed = await renameDeviceById(org.id, device.id, "Gate 3 iPhone");
    expect(renamed.label).toBe("Gate 3 iPhone");

    const longLabel = "x".repeat(100);
    const truncated = await renameDeviceById(org.id, device.id, longLabel);
    expect(truncated.label).toHaveLength(60);
  });

  it("throws when the device belongs to a different organization", async () => {
    const orgA = await createTestOrganization();
    const orgB = await createTestOrganization();
    const device = await createTestDevice(orgA.id);

    await expect(renameDeviceById(orgB.id, device.id, "Nope")).rejects.toThrow();
  });
});
