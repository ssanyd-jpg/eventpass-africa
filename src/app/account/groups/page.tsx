import { redirect } from "next/navigation";
import Link from "next/link";
import { auth } from "@/auth";
import { formatCents } from "@/lib/format";
import { getMyLedGroups } from "@/lib/ticket-group-data";

// Session 13 — every group/family checkout the signed-in buyer has led,
// scoped to leadUserId (never visible to a group member themselves, who
// may not even have an account — see Ticket.groupMemberName).
export default async function MyGroupsPage() {
  const session = await auth();
  if (!session?.user?.id) {
    redirect("/login?callbackUrl=/account/groups");
  }

  const groups = await getMyLedGroups(session.user.id);

  return (
    <div className="mx-auto max-w-3xl px-4 pb-20 pt-8 sm:px-6">
      <h1 className="mb-1 text-2xl font-bold">My Groups</h1>
      <p className="mb-6 text-sm text-muted">
        Family or team tickets you bought, and the shared wallet everyone in the group spends from.
      </p>

      {groups.length === 0 ? (
        <div className="card p-10 text-center text-muted">
          No groups yet. Choose &ldquo;Buying for a group?&rdquo; at checkout to start one.
        </div>
      ) : (
        <div className="space-y-3">
          {groups.map((g) => (
            <Link
              key={g.id}
              href={`/account/groups/${g.id}`}
              className="card flex items-center justify-between p-4 hover:bg-surface2"
            >
              <div>
                <p className="font-semibold">{g.name}</p>
                <p className="text-sm text-muted">{g.eventTitle}</p>
                <p className="text-xs text-muted">{g.provisionedCount}/{g.totalMembers} wristbands provisioned</p>
              </div>
              <p className="font-mono font-semibold">{formatCents(g.balanceCents, g.currency)}</p>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
