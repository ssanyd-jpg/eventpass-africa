import { redirect } from "next/navigation";
import { auth } from "@/auth";
import { formatDate } from "@/lib/format";
import { getMyLoyaltyStatuses, type LoyaltyTier } from "@/lib/loyalty";

const TIER_LABEL: Record<LoyaltyTier, string> = { NEW: "New", REPEAT: "Repeat", VIP: "VIP" };
const TIER_STYLE: Record<LoyaltyTier, string> = {
  NEW: "",
  REPEAT: "border-accent/40 bg-accent/10 text-accent-hover",
  VIP: "border-ok/40 bg-ok/10 text-ok",
};

export default async function LoyaltyPage() {
  const session = await auth();
  if (!session?.user?.id) {
    redirect("/login?callbackUrl=/account/loyalty");
  }

  const statuses = await getMyLoyaltyStatuses(session.user.id);

  return (
    <div className="mx-auto max-w-2xl px-4 pb-20 pt-8 sm:px-6">
      <h1 className="mb-1 text-2xl font-bold">My Status</h1>
      <p className="mb-6 text-sm text-muted">
        Your buyer status with each organizer, based on how many events
        you&apos;ve bought tickets to from them.
      </p>

      {statuses.length === 0 ? (
        <div className="card p-8 text-center text-muted">
          No purchases yet — buy a ticket to start building your status.
        </div>
      ) : (
        <div className="card divide-y divide-border">
          {statuses.map((s) => (
            <div key={s.organizationId} className="flex items-center justify-between gap-3 p-4 text-sm">
              <div>
                <p className="font-medium">{s.organizationName}</p>
                <p className="text-xs text-muted">
                  {s.ordersCount} order{s.ordersCount === 1 ? "" : "s"} · last on {formatDate(s.lastOrderAt)}
                </p>
              </div>
              <span className={`pill ${TIER_STYLE[s.tier]}`}>{TIER_LABEL[s.tier]}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
