import { redirect } from "next/navigation";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import StartPoolForm from "./StartPoolForm";
import PoolListItem from "./PoolListItem";

const poolListInclude = {
  event: { select: { title: true } },
  ticketType: { select: { name: true } },
} as const;

function toListItem(pool: {
  id: string;
  name: string | null;
  status: string;
  targetCents: number;
  raisedCents: number;
  currency: string;
  event: { title: string };
  ticketType: { name: string };
}) {
  return {
    id: pool.id,
    name: pool.name,
    status: pool.status,
    targetCents: pool.targetCents,
    raisedCents: pool.raisedCents,
    currency: pool.currency,
    eventTitle: pool.event.title,
    ticketTypeName: pool.ticketType.name,
  };
}

export default async function PoolsPage({ searchParams }: { searchParams: { startTicketTypeId?: string } }) {
  const session = await auth();
  if (!session?.user?.id) {
    redirect("/login?callbackUrl=/account/pools");
  }
  const userId = session.user.id;
  const startTicketTypeId = searchParams.startTicketTypeId;

  const [createdPools, contributingPools, receivedPools, startTicketType] = await Promise.all([
    prisma.ticketPool.findMany({ where: { creatorUserId: userId }, include: poolListInclude, orderBy: { createdAt: "desc" } }),
    prisma.ticketPool.findMany({
      where: { creatorUserId: { not: userId }, contributions: { some: { contributorUserId: userId } } },
      include: poolListInclude,
      orderBy: { createdAt: "desc" },
    }),
    prisma.ticketPool.findMany({
      where: { recipientUserId: userId, creatorUserId: { not: userId } },
      include: poolListInclude,
      orderBy: { createdAt: "desc" },
    }),
    startTicketTypeId
      ? prisma.ticketType.findUnique({
          where: { id: startTicketTypeId },
          include: { event: { select: { title: true, status: true, currency: true } } },
        })
      : null,
  ]);

  const canStartPool = !!startTicketType && startTicketType.pricingStrategy === "FIXED" && startTicketType.event.status === "LIVE";

  return (
    <div className="mx-auto max-w-2xl px-4 pb-20 pt-8 sm:px-6">
      <h1 className="mb-1 text-2xl font-bold">Ticket pools</h1>
      <p className="mb-6 text-sm text-muted">
        Pool money with friends or family toward one ticket — share a link, everyone chips in with mobile money, and the ticket
        books itself once it&apos;s fully funded.
      </p>

      {canStartPool && startTicketType && (
        <div className="mb-8">
          <StartPoolForm
            ticketTypeId={startTicketType.id}
            ticketTypeName={startTicketType.name}
            priceCents={startTicketType.priceCents}
            currency={startTicketType.event.currency}
            eventTitle={startTicketType.event.title}
          />
        </div>
      )}

      <div className="space-y-8">
        <section>
          <h2 className="mb-3 text-sm font-semibold text-muted">Pools you started</h2>
          {createdPools.length === 0 ? (
            <p className="text-sm text-muted">
              No pools yet — open an event you&apos;d like a ticket for and look for &quot;Start a group pool&quot;.
            </p>
          ) : (
            <div className="space-y-3">
              {createdPools.map((p) => (
                <PoolListItem key={p.id} pool={toListItem(p)} canCancel />
              ))}
            </div>
          )}
        </section>

        {contributingPools.length > 0 && (
          <section>
            <h2 className="mb-3 text-sm font-semibold text-muted">Pools you&apos;re contributing to</h2>
            <div className="space-y-3">
              {contributingPools.map((p) => (
                <PoolListItem key={p.id} pool={toListItem(p)} canCancel={false} />
              ))}
            </div>
          </section>
        )}

        {receivedPools.length > 0 && (
          <section>
            <h2 className="mb-3 text-sm font-semibold text-muted">Pooled for you</h2>
            <div className="space-y-3">
              {receivedPools.map((p) => (
                <PoolListItem key={p.id} pool={toListItem(p)} canCancel={false} />
              ))}
            </div>
          </section>
        )}
      </div>
    </div>
  );
}
