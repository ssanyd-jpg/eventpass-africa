"use client";

import { useCallback, useEffect, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import Link from "next/link";
import { useAppSession } from "@/lib/use-app-session";
import { setWaitlistEnabled, notifyNextInWaitlistAction } from "./actions";

interface WaitlistCount {
  ticketTypeId: string;
  ticketTypeName: string;
  waiting: number;
}

interface WaitlistPageData {
  eventTitle: string;
  waitlistEnabled: boolean;
  counts: WaitlistCount[];
}

export default function EventWaitlistPage() {
  const { id: rawId } = useParams<{ id: string }>();
  const eventId = decodeURIComponent(rawId);
  const router = useRouter();
  const { user } = useAppSession();

  useEffect(() => {
    if (user?.organizationRole === "GATE_CREW") router.replace("/dashboard");
  }, [user, router]);

  const [data, setData] = useState<WaitlistPageData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [toggling, setToggling] = useState(false);
  const [notifyCounts, setNotifyCounts] = useState<Record<string, string>>({});
  const [notifyingId, setNotifyingId] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch(`/api/dashboard/events/${eventId}/waitlist`, { cache: "no-store" });
      const body = await res.json();
      if (!res.ok || !body.ok) {
        setError(body.reason ?? "Failed to load");
        return;
      }
      setData({ eventTitle: body.eventTitle, waitlistEnabled: body.waitlistEnabled, counts: body.counts });
    } catch {
      setError("Failed to load");
    }
  }, [eventId]);

  useEffect(() => {
    load();
  }, [load]);

  async function onToggle(enabled: boolean) {
    setToggling(true);
    await setWaitlistEnabled(eventId, enabled);
    setToggling(false);
    await load();
  }

  async function onNotifyNext(ticketTypeId: string) {
    const raw = notifyCounts[ticketTypeId] ?? "1";
    const count = Math.max(1, Math.round(Number(raw) || 1));
    setNotifyingId(ticketTypeId);
    const result = await notifyNextInWaitlistAction(eventId, ticketTypeId, count);
    setNotifyingId(null);
    setNotice(
      result.notifiedCount > 0
        ? `Notified ${result.notifiedCount} waitlist ${result.notifiedCount === 1 ? "entry" : "entries"}.`
        : "No one is waiting on that ticket type."
    );
    await load();
  }

  if (user?.organizationRole === "GATE_CREW") return null;

  if (error) {
    return (
      <div className="mx-auto max-w-3xl px-4 py-16 text-center">
        <p className="text-lg font-semibold">Couldn&apos;t load this event&apos;s waitlist.</p>
        <Link href={`/dashboard/events/${eventId}`} className="btn-secondary mt-6 inline-flex">← Back to event</Link>
      </div>
    );
  }

  if (!data) {
    return <div className="mx-auto max-w-3xl px-4 py-16 text-center text-muted">Loading…</div>;
  }

  return (
    <div className="mx-auto max-w-3xl px-4 pb-20 pt-8 sm:px-6">
      <Link href={`/dashboard/events/${eventId}`} className="text-sm text-muted hover:text-foreground">
        ← {data.eventTitle}
      </Link>
      <h1 className="mb-1 mt-3 text-2xl font-bold">Waitlist</h1>
      <p className="mb-6 text-sm text-muted">
        Let attendees queue for a sold-out ticket tier and get notified by WhatsApp when a spot opens up.
      </p>

      <div className="card mb-6 flex items-center justify-between gap-4 p-5">
        <div>
          <p className="font-medium">Enable waitlist when sold out</p>
          <p className="text-sm text-muted">
            Shows &quot;Join waitlist&quot; instead of &quot;Sold out&quot; on the public event page.
          </p>
        </div>
        <label className="flex items-center gap-2">
          <input
            type="checkbox"
            checked={data.waitlistEnabled}
            disabled={toggling}
            onChange={(e) => onToggle(e.target.checked)}
          />
        </label>
      </div>

      {notice && (
        <div className="mb-4 rounded-lg border border-accent/40 bg-accent-soft px-3 py-2 text-sm text-accent-hover">
          {notice}
        </div>
      )}

      <div className="card divide-y divide-border p-0">
        {data.counts.length === 0 ? (
          <p className="p-5 text-sm text-muted">This event has no ticket types yet.</p>
        ) : (
          data.counts.map((c) => (
            <div key={c.ticketTypeId} className="flex flex-wrap items-center justify-between gap-3 p-5">
              <div>
                <p className="font-medium">{c.ticketTypeName}</p>
                <p className="text-sm text-muted">
                  {c.waiting} waiting
                </p>
              </div>
              <div className="flex items-center gap-2">
                <input
                  type="number"
                  min={1}
                  className="input w-20"
                  value={notifyCounts[c.ticketTypeId] ?? "1"}
                  onChange={(e) => setNotifyCounts((prev) => ({ ...prev, [c.ticketTypeId]: e.target.value }))}
                />
                <button
                  className="btn-secondary"
                  disabled={notifyingId === c.ticketTypeId || c.waiting === 0}
                  onClick={() => onNotifyNext(c.ticketTypeId)}
                >
                  {notifyingId === c.ticketTypeId ? "Notifying…" : "Notify next"}
                </button>
              </div>
            </div>
          ))
        )}
      </div>
    </div>
  );
}
