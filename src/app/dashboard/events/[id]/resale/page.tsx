"use client";

import { useCallback, useEffect, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import Link from "next/link";
import { useAppSession } from "@/lib/use-app-session";
import { formatCents } from "@/lib/format";
import { setResaleSettings } from "./actions";
import { SkeletonPage } from "@/components/Skeleton";

interface ResalePageData {
  eventTitle: string;
  currency: string;
  resaleEnabled: boolean;
  maxResalePrice: number | null;
  listingCounts: Record<string, number>;
}

export default function EventResalePage() {
  const { id: rawId } = useParams<{ id: string }>();
  const eventId = decodeURIComponent(rawId);
  const router = useRouter();
  const { user } = useAppSession();

  useEffect(() => {
    if (user?.organizationRole === "GATE_CREW") router.replace("/dashboard");
  }, [user, router]);

  const [data, setData] = useState<ResalePageData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [enabled, setEnabled] = useState(false);
  const [maxPrice, setMaxPrice] = useState("");
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch(`/api/dashboard/events/${eventId}/resale`, { cache: "no-store" });
      const body = await res.json();
      if (!res.ok || !body.ok) {
        setError(body.reason ?? "Failed to load");
        return;
      }
      setData({
        eventTitle: body.eventTitle,
        currency: body.currency,
        resaleEnabled: body.resaleEnabled,
        maxResalePrice: body.maxResalePrice,
        listingCounts: body.listingCounts,
      });
      setEnabled(body.resaleEnabled);
      setMaxPrice(body.maxResalePrice != null ? String(body.maxResalePrice / 100) : "");
    } catch {
      setError("Failed to load");
    }
  }, [eventId]);

  useEffect(() => {
    load();
  }, [load]);

  async function onSave() {
    setNotice(null);
    const trimmed = maxPrice.trim();
    let maxCents: number | null = null;
    if (trimmed) {
      const major = Number(trimmed);
      if (!Number.isFinite(major) || major <= 0) {
        setNotice("Enter a maximum price greater than zero, or leave it blank.");
        return;
      }
      maxCents = Math.round(major * 100);
    }
    setSaving(true);
    try {
      await setResaleSettings(eventId, enabled, maxCents);
      setNotice("Saved.");
      await load();
    } catch (e) {
      setNotice(e instanceof Error ? e.message : "Couldn't save.");
    } finally {
      setSaving(false);
    }
  }

  if (user?.organizationRole === "GATE_CREW") return null;

  if (error) {
    return (
      <div className="mx-auto max-w-3xl px-4 py-16 text-center">
        <p className="text-lg font-semibold">Couldn&apos;t load this event&apos;s resale settings.</p>
        <Link href={`/dashboard/events/${eventId}`} className="btn-secondary mt-6 inline-flex">← Back to event</Link>
      </div>
    );
  }

  if (!data) {
    return <SkeletonPage maxWidth="max-w-3xl" />;
  }

  const counts = data.listingCounts;

  return (
    <div className="mx-auto max-w-3xl px-4 pb-20 pt-8 sm:px-6">
      <Link href={`/dashboard/events/${eventId}`} className="text-sm text-muted hover:text-foreground">
        ← {data.eventTitle}
      </Link>
      <h1 className="mb-1 mt-3 text-2xl font-bold">Ticket resale</h1>
      <p className="mb-6 text-sm text-muted">
        Let attendees resell tickets they can no longer use to other fans, at face value or below. Chaap takes a 5%
        commission from the seller on each completed resale.
      </p>

      <div className="card mb-6 space-y-5 p-5">
        <div className="flex items-center justify-between gap-4">
          <div>
            <p className="font-medium">Allow ticket resale</p>
            <p className="text-sm text-muted">
              Ticket holders get a &quot;List for resale&quot; option, and a resale marketplace appears for this event.
            </p>
          </div>
          <input type="checkbox" checked={enabled} disabled={saving} onChange={(e) => setEnabled(e.target.checked)} />
        </div>

        <div>
          <label className="mb-1 block text-sm font-medium" htmlFor="max-resale-price">
            Maximum resale price ({data.currency}) — optional
          </label>
          <input
            id="max-resale-price"
            type="number"
            min={0}
            step="any"
            className="input max-w-xs"
            value={maxPrice}
            disabled={saving}
            placeholder="Face value"
            onChange={(e) => setMaxPrice(e.target.value)}
          />
          <p className="mt-1 text-xs text-muted">
            Leave blank to let sellers list at any price up to the ticket&apos;s face value. Tickets can never be resold
            above face value — this can only lower the limit further.
          </p>
        </div>

        <div className="flex items-center gap-3">
          <button className="btn-primary" disabled={saving} onClick={onSave}>
            {saving ? "Saving…" : "Save"}
          </button>
          {notice && <span className="text-sm text-muted">{notice}</span>}
        </div>
      </div>

      <h2 className="mb-3 font-semibold">Listings</h2>
      <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
        {(["ACTIVE", "SOLD", "CANCELLED", "EXPIRED"] as const).map((s) => (
          <div key={s} className="card p-4">
            <p className="text-xs uppercase tracking-wide text-muted">{s.charAt(0) + s.slice(1).toLowerCase()}</p>
            <p className="mt-1 text-2xl font-bold">{counts[s] ?? 0}</p>
          </div>
        ))}
      </div>
      {data.maxResalePrice != null && (
        <p className="mt-4 text-xs text-muted">Current cap: {formatCents(data.maxResalePrice, data.currency)} per ticket.</p>
      )}
    </div>
  );
}
