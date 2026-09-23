import { redirect } from "next/navigation";
import Link from "next/link";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { formatDate } from "@/lib/format";
import { listRewards } from "@/lib/loyalty-rewards";
import RewardForm from "./RewardForm";
import { toggleRewardAction } from "./actions";

const REWARD_TYPE_LABEL: Record<string, string> = {
  DISCOUNT_CODE: "Discount code",
  FREE_TICKET: "Free ticket",
  WALLET_CREDIT: "Wallet credit",
  CUSTOM: "Custom",
};

function valueLabel(rewardType: string, value: number): string {
  if (rewardType === "DISCOUNT_CODE") return `${value}% off`;
  if (rewardType === "WALLET_CREDIT") return `TZS ${(value / 100).toLocaleString()}`;
  return "—";
}

// Server-rendered, non-offline — mirrors dashboard/team/page.tsx's pattern
// (org-wide settings, low-frequency, no gate-offline requirement) rather
// than the Dexie-driven pages. Org-wide, not per-event: a reward belongs to
// the organisation, same scope as Team/Withdrawals/Audit.
export default async function LoyaltyRewardsPage() {
  const session = await auth();
  if (!session?.user?.id) {
    redirect("/login?callbackUrl=/dashboard/loyalty");
  }
  if (session.user.organizationRole === "GATE_CREW") {
    redirect("/dashboard");
  }

  const [rewards, events] = await Promise.all([
    listRewards(session.user.organizationId),
    prisma.event.findMany({
      where: { organizationId: session.user.organizationId },
      select: { id: true, title: true, ticketTypes: { select: { id: true, name: true } } },
      orderBy: { startsAt: "desc" },
    }),
  ]);

  return (
    <div className="mx-auto max-w-4xl px-4 pb-20 pt-8 sm:px-6">
      <Link href="/dashboard" className="text-sm text-muted hover:text-foreground">← Dashboard</Link>
      <div className="mt-3 flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold">Loyalty rewards</h1>
          <p className="text-sm text-muted">
            Give your NEW/REPEAT/VIP attendees something tangible for their loyalty tier.
          </p>
        </div>
        <a href="/api/dashboard/loyalty/export" className="btn-secondary">Export redemptions (CSV)</a>
      </div>

      <div className="mt-6">
        <RewardForm events={events} />
      </div>

      <h2 className="mb-3 mt-8 font-semibold">Your rewards</h2>
      {rewards.length === 0 ? (
        <div className="card p-8 text-center text-muted">No rewards yet — create one above.</div>
      ) : (
        <div className="card divide-y divide-border">
          {rewards.map((r) => (
            <div key={r.id} className="flex flex-wrap items-center justify-between gap-3 p-4 text-sm">
              <div>
                <p className="font-medium">
                  {r.name}
                  {!r.active && <span className="ml-2 pill border-border text-muted">Inactive</span>}
                </p>
                <p className="text-xs text-muted">
                  {REWARD_TYPE_LABEL[r.rewardType] ?? r.rewardType} · {valueLabel(r.rewardType, r.value)} · {r.requiredTier}+ tier
                  {r.eventTitle ? ` · ${r.eventTitle}${r.ticketTypeName ? ` (${r.ticketTypeName})` : ""}` : ""}
                </p>
                <p className="mt-1 text-xs text-muted">
                  Redeemed {r.redeemedCount}{r.stock !== null ? ` / ${r.stock}` : ""}
                  {r.expiresAt ? ` · expires ${formatDate(r.expiresAt)}` : ""}
                </p>
              </div>
              <form
                action={async () => {
                  "use server";
                  await toggleRewardAction(r.id, !r.active, r.name);
                }}
              >
                <button type="submit" className="btn-secondary !px-3 !py-1.5 text-xs">
                  {r.active ? "Deactivate" : "Activate"}
                </button>
              </form>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
