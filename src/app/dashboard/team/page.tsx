import { redirect } from "next/navigation";
import Link from "next/link";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { formatDate } from "@/lib/format";
import InviteForm from "./InviteForm";
import { removeMember } from "./actions";

// Server-rendered, non-offline — mirrors dashboard/analytics/page.tsx's
// pattern rather than the offline-first Dexie pages. Team management is
// low-frequency and doesn't need to work at a gate with no signal.
export default async function TeamPage() {
  const session = await auth();
  if (!session?.user?.id) {
    redirect("/login?callbackUrl=/dashboard/team");
  }

  if (session.user.organizationRole !== "OWNER") {
    return (
      <div className="mx-auto max-w-2xl px-4 pb-20 pt-8 text-center sm:px-6">
        <Link href="/dashboard" className="text-sm text-muted hover:text-foreground">← Dashboard</Link>
        <p className="mt-10 font-semibold">Only the organization owner can manage the team.</p>
      </div>
    );
  }

  const [members, invites] = await Promise.all([
    prisma.organizationMembership.findMany({
      where: { organizationId: session.user.organizationId },
      include: { user: { select: { id: true, name: true, email: true } } },
      orderBy: { createdAt: "asc" },
    }),
    prisma.organizationInvite.findMany({
      where: { organizationId: session.user.organizationId, status: "PENDING", expiresAt: { gt: new Date() } },
      orderBy: { createdAt: "desc" },
    }),
  ]);

  return (
    <div className="mx-auto max-w-2xl px-4 pb-20 pt-8 sm:px-6">
      <Link href="/dashboard" className="text-sm text-muted hover:text-foreground">← Dashboard</Link>
      <h1 className="mb-1 mt-3 text-2xl font-bold">{session.user.organizationName}</h1>
      <p className="mb-6 text-sm text-muted">Team members can manage your events, vendors, and wallets.</p>

      <h2 className="mb-3 font-semibold">Members</h2>
      <div className="card mb-8 divide-y divide-border">
        {members.map((m) => (
          <div key={m.id} className="flex items-center justify-between gap-3 p-4 text-sm">
            <div>
              <p className="font-medium">{m.user.name}</p>
              <p className="text-xs text-muted">{m.user.email}</p>
            </div>
            <div className="flex items-center gap-3">
              <span className="pill">{m.role}</span>
              {m.role !== "OWNER" && (
                <form
                  action={async () => {
                    "use server";
                    await removeMember(m.user.id);
                  }}
                >
                  <button type="submit" className="text-xs font-medium text-danger hover:underline">
                    Remove
                  </button>
                </form>
              )}
            </div>
          </div>
        ))}
      </div>

      {invites.length > 0 && (
        <>
          <h2 className="mb-3 font-semibold">Pending invites</h2>
          <div className="card mb-8 divide-y divide-border">
            {invites.map((i) => (
              <div key={i.id} className="flex items-center justify-between gap-3 p-4 text-sm">
                <p className="font-medium">{i.email}</p>
                <span className="text-xs text-muted">Sent {formatDate(i.createdAt)}</span>
              </div>
            ))}
          </div>
        </>
      )}

      <InviteForm />
    </div>
  );
}
