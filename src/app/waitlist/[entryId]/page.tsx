"use client";

import { useCallback, useEffect, useState } from "react";
import { useParams } from "next/navigation";
import Link from "next/link";
import Spinner from "@/components/Spinner";

interface WaitlistEntryData {
  id: string;
  name: string;
  status: "WAITING" | "NOTIFIED" | "CONVERTED" | "EXPIRED";
  position: number;
  notifiedAt: string | null;
  expiresAt: string | null;
  eventSlug: string;
  eventTitle: string;
  ticketTypeName: string;
}

function formatCountdown(msRemaining: number): string {
  const totalSeconds = Math.max(0, Math.floor(msRemaining / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  return `${hours}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}

export default function WaitlistEntryPage() {
  const { entryId } = useParams<{ entryId: string }>();
  const [entry, setEntry] = useState<WaitlistEntryData | null>(null);
  const [notFound, setNotFound] = useState(false);
  const [leaving, setLeaving] = useState(false);
  const [left, setLeft] = useState(false);
  const [now, setNow] = useState(() => Date.now());

  const load = useCallback(async () => {
    const res = await fetch(`/api/waitlist/${entryId}`, { cache: "no-store" });
    if (!res.ok) {
      setNotFound(true);
      return;
    }
    const data = await res.json();
    setEntry(data.entry);
  }, [entryId]);

  useEffect(() => {
    load();
    // Refreshed every 30s — the same cadence the leaderboard's public poll
    // uses — so a NOTIFIED transition or an organiser-triggered release
    // shows up without the attendee needing to reload.
    const interval = setInterval(load, 30000);
    return () => clearInterval(interval);
  }, [load]);

  useEffect(() => {
    if (!entry || entry.status !== "NOTIFIED") return;
    const tick = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(tick);
  }, [entry]);

  async function onLeave() {
    setLeaving(true);
    const res = await fetch(`/api/waitlist/${entryId}`, { method: "DELETE" });
    setLeaving(false);
    if (res.ok) setLeft(true);
  }

  if (notFound) {
    return (
      <div className="mx-auto max-w-lg px-4 py-16 text-center">
        <p className="text-lg font-semibold">Waitlist entry not found.</p>
        <Link href="/" className="btn-secondary mt-6 inline-flex">Back to browse</Link>
      </div>
    );
  }

  if (!entry) {
    return (
      <div className="mx-auto flex max-w-lg flex-col items-center gap-3 px-4 py-16 text-center text-muted">
        <Spinner />
        <span>Loading…</span>
      </div>
    );
  }

  if (left) {
    return (
      <div className="mx-auto max-w-lg px-4 py-16 text-center">
        <p className="text-lg font-semibold">You&apos;ve left the waitlist</p>
        <p className="mt-2 text-sm text-muted">Your spot has been given to the next person in line.</p>
        <Link href={`/events/${entry.eventSlug}`} className="btn-secondary mt-6 inline-flex">← {entry.eventTitle}</Link>
      </div>
    );
  }

  const msRemaining = entry.expiresAt ? new Date(entry.expiresAt).getTime() - now : 0;

  return (
    <div className="mx-auto max-w-lg px-4 pb-20 pt-8 sm:px-6">
      <Link href={`/events/${entry.eventSlug}`} className="text-sm text-muted hover:text-foreground">
        ← {entry.eventTitle}
      </Link>
      <h1 className="mb-1 mt-3 text-2xl font-bold">Waitlist — {entry.ticketTypeName}</h1>
      <p className="mb-6 text-sm text-muted">{entry.eventTitle}</p>

      {entry.status === "NOTIFIED" ? (
        <div className="card space-y-4 p-6">
          <p className="pill border-accent/40 bg-accent-soft text-accent-hover">A spot is available</p>
          <p className="text-sm text-foreground/90">
            Good news, {entry.name} — a {entry.ticketTypeName} ticket just opened up. Complete your
            purchase before the timer runs out or it goes to the next person on the list.
          </p>
          {msRemaining > 0 ? (
            <p className="text-center text-3xl font-bold tabular-nums">{formatCountdown(msRemaining)}</p>
          ) : (
            <p className="text-center text-sm text-muted">This offer has expired — refresh to see your updated status.</p>
          )}
          <Link href={`/events/${entry.eventSlug}?waitlistEntryId=${entry.id}`} className="btn-primary w-full">
            Buy your ticket now
          </Link>
        </div>
      ) : entry.status === "CONVERTED" ? (
        <div className="card p-6 text-center">
          <p className="font-semibold text-ok">Ticket purchased 🎉</p>
          <p className="mt-2 text-sm text-muted">You&apos;re all set — check your order confirmation for details.</p>
        </div>
      ) : entry.status === "EXPIRED" ? (
        <div className="card p-6 text-center">
          <p className="font-semibold text-danger">Your offer expired</p>
          <p className="mt-2 text-sm text-muted">
            The 2-hour purchase window closed and the spot moved to the next person on the list.
          </p>
        </div>
      ) : (
        <div className="card space-y-4 p-6">
          <p className="text-sm text-muted">You are</p>
          <p className="text-4xl font-bold tabular-nums">#{entry.position}</p>
          <p className="text-sm text-muted">
            on the waitlist for {entry.ticketTypeName}. We&apos;ll send you a WhatsApp message the
            moment a spot opens up — you&apos;ll have 2 hours to complete your purchase.
          </p>
          <button className="btn-secondary w-full" disabled={leaving} onClick={onLeave}>
            {leaving ? "Leaving…" : "Leave waitlist"}
          </button>
        </div>
      )}
    </div>
  );
}
