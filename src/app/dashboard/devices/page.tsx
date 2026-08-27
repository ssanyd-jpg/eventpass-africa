import { redirect } from "next/navigation";
import Link from "next/link";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { formatDateTime } from "@/lib/format";
import { revokeDevice, reactivateDevice, renameDevice } from "./actions";

// Server-rendered, non-offline — same reasoning as dashboard/team/page.tsx
// and dashboard/audit/page.tsx: low-frequency OWNER admin surface, doesn't
// need to work at a gate with no signal.
export default async function DevicesPage() {
  const session = await auth();
  if (!session?.user?.id) {
    redirect("/login?callbackUrl=/dashboard/devices");
  }

  if (session.user.organizationRole !== "OWNER") {
    return (
      <div className="mx-auto max-w-2xl px-4 pb-20 pt-8 text-center sm:px-6">
        <Link href="/dashboard" className="text-sm text-muted hover:text-foreground">← Dashboard</Link>
        <p className="mt-10 font-semibold">Only the organization owner can manage devices.</p>
      </div>
    );
  }

  const devices = await prisma.device.findMany({
    where: { organizationId: session.user.organizationId },
    orderBy: { lastSeenAt: "desc" },
  });

  return (
    <div className="mx-auto max-w-2xl px-4 pb-20 pt-8 sm:px-6">
      <Link href="/dashboard" className="text-sm text-muted hover:text-foreground">← Dashboard</Link>
      <h1 className="mb-1 mt-3 text-2xl font-bold">Devices</h1>
      <p className="mb-6 text-sm text-muted">
        Every phone or tablet that has synced for your organization. Revoke one to cut off a lost or
        retired device without touching the person&apos;s account.
      </p>

      {devices.length === 0 ? (
        <div className="card p-8 text-center text-muted">No devices have synced yet.</div>
      ) : (
        <div className="card divide-y divide-border">
          {devices.map((d) => {
            const fallbackLabel = `Device ${d.deviceId.slice(0, 8)}`;
            return (
              <div key={d.id} className="space-y-3 p-4 text-sm">
                <div className="flex items-center justify-between gap-3">
                  <div>
                    <p className="font-medium">{d.label || fallbackLabel}</p>
                    <p className="text-xs text-muted">
                      Last seen {formatDateTime(d.lastSeenAt)} · by {d.lastSeenByName}
                    </p>
                  </div>
                  <div className="flex items-center gap-3">
                    {d.revokedAt ? (
                      <span className="inline-flex items-center rounded-full border border-danger/40 bg-danger/10 px-3 py-1 text-xs font-medium text-danger">
                        Revoked
                      </span>
                    ) : (
                      <span className="pill">Active</span>
                    )}
                    {d.revokedAt ? (
                      <form
                        action={async () => {
                          "use server";
                          await reactivateDevice(d.id);
                        }}
                      >
                        <button type="submit" className="text-xs font-medium text-accent hover:underline">
                          Reactivate
                        </button>
                      </form>
                    ) : (
                      <form
                        action={async () => {
                          "use server";
                          await revokeDevice(d.id);
                        }}
                      >
                        <button type="submit" className="text-xs font-medium text-danger hover:underline">
                          Revoke
                        </button>
                      </form>
                    )}
                  </div>
                </div>
                <form action={renameDevice} className="flex items-center gap-2">
                  <input type="hidden" name="deviceId" value={d.id} />
                  <input
                    type="text"
                    name="label"
                    defaultValue={d.label}
                    placeholder={fallbackLabel}
                    className="input py-1.5 text-xs"
                  />
                  <button type="submit" className="shrink-0 text-xs font-medium text-muted hover:text-foreground">
                    Save name
                  </button>
                </form>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
