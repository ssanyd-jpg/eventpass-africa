import { redirect } from "next/navigation";
import Link from "next/link";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import BroadcastComposer from "./BroadcastComposer";

// OWNER-only — consequential/spam-risk action, matches the gate pattern
// used by dashboard/team, dashboard/audit, and dashboard/devices.
export default async function BroadcastPage() {
  const session = await auth();
  if (!session?.user?.id) {
    redirect("/login?callbackUrl=/dashboard/customers/broadcast");
  }

  if (session.user.organizationRole !== "OWNER") {
    return (
      <div className="mx-auto max-w-2xl px-4 pb-20 pt-8 text-center sm:px-6">
        <Link href="/dashboard/customers" className="text-sm text-muted hover:text-foreground">← Customers</Link>
        <p className="mt-10 font-semibold">Only the organization owner can send broadcasts.</p>
      </div>
    );
  }

  const events = await prisma.event.findMany({
    where: { organizationId: session.user.organizationId },
    select: { id: true, title: true, ticketTypes: { select: { id: true, name: true } } },
    orderBy: { startsAt: "desc" },
  });

  return (
    <div className="mx-auto max-w-2xl px-4 pb-20 pt-8 sm:px-6">
      <Link href="/dashboard/customers" className="text-sm text-muted hover:text-foreground">← Customers</Link>
      <h1 className="mb-1 mt-3 text-2xl font-bold">Broadcast</h1>
      <p className="mb-6 text-sm text-muted">
        Message everyone who bought a ticket to one of your events, or narrow it to a specific ticket type.
      </p>
      <BroadcastComposer events={events} />
    </div>
  );
}
