"use client";

import { useEffect, useState } from "react";
import { useLiveQuery } from "dexie-react-hooks";
import { useParams, useRouter } from "next/navigation";
import Link from "next/link";
import { db, newLocalId, type LocalSponsor } from "@/lib/db";
import { queueOp } from "@/lib/sync-engine";
import { useAppSession } from "@/lib/use-app-session";
import { formatCents } from "@/lib/format";

const SPONSOR_TIERS = ["Platinum", "Gold", "Silver", "Bronze", "Other"];

export default function ManageSponsorsPage() {
  const { id: rawId } = useParams<{ id: string }>();
  const id = decodeURIComponent(rawId);
  const router = useRouter();
  const { user } = useAppSession();

  // Middleware already redirects GATE_CREW away from this route server-side
  // — this is defense-in-depth for a device offline with an already-cached
  // page shell (see src/middleware.ts).
  useEffect(() => {
    if (user?.organizationRole === "GATE_CREW") router.replace("/dashboard");
  }, [user, router]);

  const event = useLiveQuery(async () => {
    const byId = await db.events.get(id);
    return byId ?? (await db.events.where("clientId").equals(id).first()) ?? null;
  }, [id]);

  const sponsors = useLiveQuery(async () => {
    if (!event) return [];
    const all = await db.sponsors.where("eventId").equals(event.id).toArray();
    return all.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
  }, [event?.id]);

  // Lead count per sponsor, computed client-side from the same
  // walletTransactions table the organizer analytics page already reads
  // (populated by payload.myWalletTransactions on every pull) — avoids a
  // second server round-trip just to show a number next to each sponsor.
  const leadCounts = useLiveQuery(async () => {
    if (!sponsors || sponsors.length === 0) return {};
    const taps = await db.walletTransactions.where("type").equals("SPONSOR_TAP").toArray();
    const counts: Record<string, number> = {};
    for (const t of taps) {
      if (t.sponsorId) counts[t.sponsorId] = (counts[t.sponsorId] ?? 0) + 1;
    }
    return counts;
  }, [sponsors]);

  const [showAddForm, setShowAddForm] = useState(false);
  const [addName, setAddName] = useState("");
  const [addTier, setAddTier] = useState(SPONSOR_TIERS[0]);
  const [addFeeMajor, setAddFeeMajor] = useState("");
  const [adding, setAdding] = useState(false);

  if (user?.organizationRole === "GATE_CREW") return null;

  if (event === undefined) {
    return <div className="mx-auto max-w-3xl px-4 py-16 text-center text-muted">Loading…</div>;
  }

  if (!event) {
    return (
      <div className="mx-auto max-w-3xl px-4 py-16 text-center">
        <p className="font-semibold">Event not found on this device.</p>
        <Link href="/dashboard" className="btn-secondary mt-6 inline-flex">Back to dashboard</Link>
      </div>
    );
  }

  async function addSponsor(e: React.FormEvent) {
    e.preventDefault();
    if (!addName.trim() || !event) return;
    setAdding(true);

    const clientId = newLocalId();
    const feeCents = Math.round(parseFloat(addFeeMajor || "0") * 100);
    const sponsor: LocalSponsor = {
      id: clientId,
      clientId,
      eventId: event.id,
      eventClientId: event.clientId,
      name: addName.trim(),
      tier: addTier,
      description: "",
      contactEmail: "",
      contactPhone: "",
      feeCents,
      currency: event.currency,
      feeStatus: feeCents > 0 ? "PAID" : "NONE",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      syncStatus: "pending",
    };

    await db.sponsors.put(sponsor);
    await queueOp("ADD_SPONSOR", {
      clientId,
      eventId: event.id,
      eventClientId: event.clientId,
      name: sponsor.name,
      tier: sponsor.tier,
      feeCents,
      feeStatus: sponsor.feeStatus,
    });

    setAddName("");
    setAddFeeMajor("");
    setAddTier(SPONSOR_TIERS[0]);
    setShowAddForm(false);
    setAdding(false);
  }

  return (
    <div className="mx-auto max-w-3xl px-4 pb-20 pt-8 sm:px-6">
      <Link href={`/dashboard/events/${event.id}`} className="text-sm text-muted hover:text-foreground">
        ← {event.title}
      </Link>
      <div className="mt-3 flex items-center justify-between">
        <h1 className="text-2xl font-bold">Sponsors</h1>
        <button className="btn-secondary" onClick={() => setShowAddForm((v) => !v)}>
          + Add sponsor
        </button>
      </div>

      {showAddForm && (
        <form onSubmit={addSponsor} className="card mt-4 space-y-3 p-4">
          <div className="grid grid-cols-[1fr_140px] gap-3">
            <div>
              <label className="label" htmlFor="addName">Name</label>
              <input id="addName" className="input" value={addName} onChange={(e) => setAddName(e.target.value)} required />
            </div>
            <div>
              <label className="label" htmlFor="addTier">Tier</label>
              <select id="addTier" className="input" value={addTier} onChange={(e) => setAddTier(e.target.value)}>
                {SPONSOR_TIERS.map((t) => (
                  <option key={t} value={t}>{t}</option>
                ))}
              </select>
            </div>
          </div>
          <div>
            <label className="label" htmlFor="addFee">Sponsorship fee ({event.currency}, optional)</label>
            <input
              id="addFee"
              type="number"
              min="0"
              step="1000"
              className="input"
              value={addFeeMajor}
              onChange={(e) => setAddFeeMajor(e.target.value)}
            />
          </div>
          <button type="submit" disabled={adding} className="btn-primary w-full">
            {adding ? "Adding…" : "Add sponsor"}
          </button>
        </form>
      )}

      <h2 className="mb-3 mt-8 font-semibold">Sponsors ({(sponsors ?? []).length})</h2>
      {(sponsors ?? []).length === 0 ? (
        <div className="card p-8 text-center text-muted">No sponsors added yet.</div>
      ) : (
        <div className="card divide-y divide-border">
          {(sponsors ?? []).map((s) => (
            <div key={s.id} className="flex flex-wrap items-center justify-between gap-3 p-4">
              <div>
                <p className="font-medium">
                  {s.name}
                  {s.syncStatus === "pending" && (
                    <span className="ml-2 pill border-warn/40 bg-warn/10 text-warn">Pending sync</span>
                  )}
                </p>
                <p className="text-sm text-muted">
                  {s.tier}
                  {s.feeCents > 0 && ` · ${formatCents(s.feeCents, s.currency)} (${s.feeStatus === "PAID" ? "paid" : s.feeStatus})`}
                </p>
              </div>
              {/* Leads only exist once a sponsor has a real server id — a
                  still-pending-sync sponsor (local temp id) has no rows to
                  show yet. */}
              {!s.syncStatus || s.syncStatus === "synced" ? (
                <Link
                  href={`/dashboard/events/${event.id}/sponsors/${s.id}/leads`}
                  className="text-sm font-medium text-accent-hover"
                >
                  Leads ({leadCounts?.[s.id] ?? 0}) →
                </Link>
              ) : null}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
