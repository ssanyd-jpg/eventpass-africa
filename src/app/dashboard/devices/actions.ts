"use server";

import { revalidatePath } from "next/cache";
import { auth } from "@/auth";
import { logAudit } from "@/lib/audit";
import { revokeDeviceById, reactivateDeviceById, renameDeviceById } from "@/lib/device-handlers";

async function requireOwner() {
  const session = await auth();
  if (!session?.user?.id || session.user.organizationRole !== "OWNER") {
    throw new Error("Forbidden");
  }
  return session;
}

export async function revokeDevice(deviceRowId: string) {
  const session = await requireOwner();
  const device = await revokeDeviceById(session.user.organizationId, deviceRowId, session.user.id);
  await logAudit({
    organizationId: session.user.organizationId,
    actorUserId: session.user.id,
    actorName: session.user.name ?? session.user.email ?? "Unknown",
    action: "DEVICE_REVOKED",
    summary: `Revoked device "${device.label || device.deviceId.slice(0, 8)}"`,
  });
  revalidatePath("/dashboard/devices");
}

export async function reactivateDevice(deviceRowId: string) {
  const session = await requireOwner();
  const device = await reactivateDeviceById(session.user.organizationId, deviceRowId);
  await logAudit({
    organizationId: session.user.organizationId,
    actorUserId: session.user.id,
    actorName: session.user.name ?? session.user.email ?? "Unknown",
    action: "DEVICE_REACTIVATED",
    summary: `Reactivated device "${device.label || device.deviceId.slice(0, 8)}"`,
  });
  revalidatePath("/dashboard/devices");
}

// Cosmetic label edit, not an accountability event — deliberately not
// audited, same discipline that excludes check-ins from the audit log.
export async function renameDevice(formData: FormData) {
  const session = await requireOwner();
  const deviceRowId = formData.get("deviceId");
  const label = formData.get("label");
  if (typeof deviceRowId !== "string" || typeof label !== "string") {
    throw new Error("Invalid form submission.");
  }
  await renameDeviceById(session.user.organizationId, deviceRowId, label);
  revalidatePath("/dashboard/devices");
}
