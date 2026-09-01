"use client";

import { useEffect, useState } from "react";
import { useLiveQuery } from "dexie-react-hooks";
import { useParams, useRouter } from "next/navigation";
import Link from "next/link";
import { db, newLocalId, type LocalSponsorCampaign } from "@/lib/db";
import { queueOp } from "@/lib/sync-engine";
import { useAppSession } from "@/lib/use-app-session";
import { formatDate } from "@/lib/format";
import { detectCampaignRedemptionAnomalies } from "@/lib/anomaly";

// A client component, unlike the read-only leads page — campaign creation
// is a queueOp mutation exactly like ADD_SPONSOR, so this mirrors
// sponsors/page.tsx's shape rather than leads/page.tsx's.
export default function SponsorCampaignsPage() {
  const { id: rawId, sponsorId: rawSponsorId } = useParams<{ id: string; sponsorId: string }>();
  const id = decodeURIComponent(rawId);
  const sponsorId = decodeURIComponent(rawSponsorId);
  const router = useRouter();
  const { user } = useAppSession();

  useEffect(() => {
    if (user?.organizationRole === "GATE_CREW") router.replace("/dashboard");
  }, [user, router]);

  const event = useLiveQuery(async () => {
    const byId = await db.events.get(id);
    return byId ?? (await db.events.where("clientId").equals(id).first()) ?? null;
  }, [id]);

  const sponsor = useLiveQuery(async () => {
    const byId = await db.sponsors.get(sponsorId);
    return byId ?? (await db.sponsors.where("clientId").equals(sponsorId).first()) ?? null;
  }, [sponsorId]);

  const campaigns = useLiveQuery(async () => {
    if (!sponsor) return [];
    const all = await db.sponsorCampaigns.where("sponsorId").equals(sponsor.id).toArray();
    return all.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
  }, [sponsor?.id]);

  // Deterministic, not Claude-backed — see anomaly.ts's header comment.
  // Flags a coordinated multi-wallet redemption burst on a campaign; the
  // existing @@unique([campaignId, walletId]) constraint already stops one
  // wallet redeeming twice, so this catches what that constraint can't see.
  const campaignAnomalies = useLiveQuery(async () => {
    if (!campaigns || campaigns.length === 0) return new Map<string, string[]>();
    const allTaps = await db.walletTransactions.toArray();
    const redemptions = allTaps
      .filter((t): t is typeof t & { campaignId: string } => t.type === "SPONSOR_TAP" && !!t.campaignId)
      .map((t) => ({ id: t.id, campaignId: t.campaignId, walletId: t.walletId, createdAt: t.createdAt }));
    const flags = detectCampaignRedemptionAnomalies(redemptions);
    const byCampaignId = new Map<string, string[]>();
    // relatedId on each flag is a WalletTransaction id — map it back to the
    // campaign it belongs to so the badge can render next to the campaign
    // row, not a specific tap.
    const campaignIdByTapId = new Map(redemptions.map((r) => [r.id, r.campaignId]));
    for (const flag of flags) {
      const campaignId = campaignIdByTapId.get(flag.relatedId);
      if (!campaignId) continue;
      byCampaignId.set(campaignId, [...(byCampaignId.get(campaignId) ?? []), flag.message]);
    }
    return byCampaignId;
  }, [campaigns]);

  const [showAddForm, setShowAddForm] = useState(false);
  const [addName, setAddName] = useState("");
  const [addCode, setAddCode] = useState("");
  const [addMaxRedemptions, setAddMaxRedemptions] = useState("");
  const [addExpiresAt, setAddExpiresAt] = useState("");
  const [adding, setAdding] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (user?.organizationRole === "GATE_CREW") return null;

  if (event === undefined || sponsor === undefined) {
    return <div className="mx-auto max-w-3xl px-4 py-16 text-center text-muted">Loading…</div>;
  }

  if (!event || !sponsor) {
    return (
      <div className="mx-auto max-w-3xl px-4 py-16 text-center">
        <p className="font-semibold">Not found on this device.</p>
        <Link href="/dashboard" className="btn-secondary mt-6 inline-flex">Back to dashboard</Link>
      </div>
    );
  }

  async function addCampaign(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (!addName.trim() || !addCode.trim() || !sponsor) return;
    if (addCode.trim().length < 2) {
      setError("Code needs at least 2 characters.");
      return;
    }
    setAdding(true);

    const clientId = newLocalId();
    const campaign: LocalSponsorCampaign = {
      id: clientId,
      clientId,
      sponsorId: sponsor.id,
      name: addName.trim(),
      code: addCode.trim().toUpperCase(),
      maxRedemptions: addMaxRedemptions ? parseInt(addMaxRedemptions, 10) : null,
      redemptionCount: 0,
      expiresAt: addExpiresAt ? new Date(addExpiresAt).toISOString() : null,
      active: true,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    await db.sponsorCampaigns.put(campaign);
    await queueOp("ADD_SPONSOR_CAMPAIGN", {
      clientId,
      sponsorId: sponsor.id,
      name: campaign.name,
      code: campaign.code,
      maxRedemptions: campaign.maxRedemptions ?? undefined,
      expiresAt: campaign.expiresAt,
    });

    setAddName("");
    setAddCode("");
    setAddMaxRedemptions("");
    setAddExpiresAt("");
    setShowAddForm(false);
    setAdding(false);
  }

  async function deactivate(campaign: LocalSponsorCampaign) {
    await db.sponsorCampaigns.put({ ...campaign, active: false });
    await queueOp("DEACTIVATE_SPONSOR_CAMPAIGN", {
      clientId: newLocalId(),
      campaignId: campaign.id,
      campaignClientId: campaign.clientId,
    });
  }

  return (
    <div className="mx-auto max-w-3xl px-4 pb-20 pt-8 sm:px-6">
      <Link href={`/dashboard/events/${event.id}/sponsors`} className="text-sm text-muted hover:text-foreground">
        ← Sponsors
      </Link>
      <div className="mt-3 flex items-center justify-between">
        <h1 className="text-2xl font-bold">{sponsor.name} — Campaigns</h1>
        <button className="btn-secondary" onClick={() => setShowAddForm((v) => !v)}>
          + Add campaign
        </button>
      </div>
      <p className="mb-4 mt-1 text-sm text-muted">
        A redeemable coupon for this sponsor&apos;s booth — a sample, a
        raffle entry, a prize. Redeemed at the wallet scan terminal
        alongside a lead-capture tap.
      </p>

      {showAddForm && (
        <form onSubmit={addCampaign} className="card mt-4 space-y-3 p-4">
          <div className="grid grid-cols-[1fr_140px] gap-3">
            <div>
              <label className="label" htmlFor="addName">Name</label>
              <input id="addName" className="input" value={addName} onChange={(e) => setAddName(e.target.value)} required />
            </div>
            <div>
              <label className="label" htmlFor="addCode">Code</label>
              <input
                id="addCode"
                className="input uppercase"
                value={addCode}
                onChange={(e) => setAddCode(e.target.value)}
                required
                maxLength={30}
              />
            </div>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="label" htmlFor="addMax">Max redemptions (optional)</label>
              <input
                id="addMax"
                type="number"
                min="1"
                className="input"
                value={addMaxRedemptions}
                onChange={(e) => setAddMaxRedemptions(e.target.value)}
              />
            </div>
            <div>
              <label className="label" htmlFor="addExpires">Expires (optional)</label>
              <input
                id="addExpires"
                type="date"
                className="input"
                value={addExpiresAt}
                onChange={(e) => setAddExpiresAt(e.target.value)}
              />
            </div>
          </div>
          {error && <p className="text-sm text-danger">{error}</p>}
          <button type="submit" disabled={adding} className="btn-primary w-full">
            {adding ? "Adding…" : "Add campaign"}
          </button>
        </form>
      )}

      <h2 className="mb-3 mt-8 font-semibold">Campaigns ({(campaigns ?? []).length})</h2>
      {(campaigns ?? []).length === 0 ? (
        <div className="card p-8 text-center text-muted">No campaigns yet.</div>
      ) : (
        <div className="card divide-y divide-border">
          {(campaigns ?? []).map((c) => (
            <div key={c.id} className="flex flex-wrap items-center justify-between gap-3 p-4">
              <div>
                <p className="font-medium">
                  {c.name}
                  {!c.active && <span className="ml-2 pill">Inactive</span>}
                  {campaignAnomalies?.has(c.id) && (
                    <span
                      className="ml-2 pill border-warn/40 bg-warn/10 text-warn"
                      title={campaignAnomalies.get(c.id)?.join("; ")}
                    >
                      Unusual activity
                    </span>
                  )}
                </p>
                <p className="text-sm text-muted">
                  Code {c.code} · {c.redemptionCount}{c.maxRedemptions != null ? `/${c.maxRedemptions}` : ""} redeemed
                  {c.expiresAt && ` · expires ${formatDate(c.expiresAt)}`}
                </p>
              </div>
              {c.active && (
                <button
                  type="button"
                  className="text-xs font-medium text-muted hover:text-danger"
                  onClick={() => deactivate(c)}
                >
                  Deactivate
                </button>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
