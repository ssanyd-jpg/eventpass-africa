import { redirect } from "next/navigation";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { formatDate, formatCents } from "@/lib/format";
import { getMyLoyaltyStatuses, type LoyaltyTier } from "@/lib/loyalty";
import { getEligibleRewards } from "@/lib/loyalty-rewards";
import RedeemButton from "./RedeemButton";

const TIER_LABEL: Record<LoyaltyTier, string> = { NEW: "New", REPEAT: "Repeat", VIP: "VIP" };
const TIER_STYLE: Record<LoyaltyTier, string> = {
  NEW: "",
  REPEAT: "border-accent/40 bg-accent/10 text-accent-hover",
  VIP: "border-ok/40 bg-ok/10 text-ok",
};
const REWARD_TYPE_LABEL: Record<string, string> = {
  DISCOUNT_CODE: "Discount code",
  FREE_TICKET: "Free ticket",
  WALLET_CREDIT: "Wallet credit",
  CUSTOM: "Custom",
};

function valueLabel(rewardType: string, value: number): string {
  if (rewardType === "DISCOUNT_CODE") return `${value}% off`;
  if (rewardType === "WALLET_CREDIT") return formatCents(value, "TZS");
  return "";
}

// Session 33 — mirrors account/loyalty/page.tsx's per-organisation layout
// (that page shows tier status only; this one adds what a tier actually
// unlocks). Iterates every organisation the attendee has ever ordered
// from, same as getMyLoyaltyStatuses' own scope — an org with zero active
// rewards just shows tier progress and no reward list.
export default async function RewardsPage() {
  const session = await auth();
  if (!session?.user?.id) {
    redirect("/login?callbackUrl=/account/rewards");
  }
  const userId = session.user.id;

  const statuses = await getMyLoyaltyStatuses(userId);
  const [perOrg, history] = await Promise.all([
    Promise.all(statuses.map(async (s) => ({ status: s, eligible: await getEligibleRewards(userId, s.organizationId) }))),
    prisma.loyaltyRedemption.findMany({
      where: { userId },
      include: { reward: { select: { name: true, rewardType: true, organization: { select: { name: true } } } }, event: { select: { title: true } } },
      orderBy: { redeemedAt: "desc" },
    }),
  ]);

  return (
    <div className="mx-auto max-w-2xl px-4 pb-20 pt-8 sm:px-6">
      <h1 className="mb-1 text-2xl font-bold">My Rewards</h1>
      <p className="mb-6 text-sm text-muted">
        What your buyer status with each organizer unlocks.
      </p>

      {statuses.length === 0 ? (
        <div className="card p-8 text-center text-muted">
          No purchases yet — buy a ticket to start building your status.
        </div>
      ) : (
        <div className="space-y-6">
          {perOrg.map(({ status, eligible }) => (
            <div key={status.organizationId} className="card p-5">
              <div className="flex items-center justify-between gap-3">
                <div>
                  <p className="font-semibold">{status.organizationName}</p>
                  <p className="text-xs text-muted">
                    {status.ordersCount} order{status.ordersCount === 1 ? "" : "s"}
                    {eligible.progress.nextTier
                      ? ` · ${eligible.progress.ordersToNextTier} more to ${TIER_LABEL[eligible.progress.nextTier]}`
                      : " · top tier reached"}
                  </p>
                </div>
                <span className={`pill ${TIER_STYLE[status.tier]}`}>{TIER_LABEL[status.tier]}</span>
              </div>

              {eligible.rewards.length > 0 && (
                <div className="mt-4 divide-y divide-border border-t border-border">
                  {eligible.rewards.map((r) => (
                    <div key={r.id} className="flex flex-wrap items-center justify-between gap-3 py-3 text-sm">
                      <div>
                        <p className="font-medium">{r.name}</p>
                        {r.description && <p className="text-xs text-muted">{r.description}</p>}
                        <p className="mt-0.5 text-xs text-muted">
                          {REWARD_TYPE_LABEL[r.rewardType] ?? r.rewardType}
                          {valueLabel(r.rewardType, r.value) ? ` · ${valueLabel(r.rewardType, r.value)}` : ""}
                          {r.eventTitle ? ` · ${r.eventTitle}` : ""}
                          {r.expiresAt ? ` · expires ${formatDate(r.expiresAt)}` : ""}
                        </p>
                      </div>
                      <RedeemButton
                        rewardId={r.id}
                        disabled={r.blocker !== null}
                        disabledReason={r.alreadyRedeemed ? "Already redeemed" : r.blocker}
                      />
                    </div>
                  ))}
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      {history.length > 0 && (
        <>
          <h2 className="mb-3 mt-8 font-semibold">Redemption history</h2>
          <div className="card divide-y divide-border">
            {history.map((h) => (
              <div key={h.id} className="flex items-center justify-between gap-3 p-4 text-sm">
                <div>
                  <p className="font-medium">{h.reward.name}</p>
                  <p className="text-xs text-muted">
                    {h.reward.organization.name}
                    {h.event ? ` · ${h.event.title}` : ""} · {formatDate(h.redeemedAt)}
                  </p>
                </div>
                <span className="text-xs text-muted">{valueLabel(h.reward.rewardType, h.value)}</span>
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
