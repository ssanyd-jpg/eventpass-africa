"use client";

import { useEffect, useState } from "react";
import { useParams } from "next/navigation";
import { formatDateTime } from "@/lib/format";
import TicketQr from "@/components/TicketQr";

interface VolunteerPortalData {
  eventTitle: string;
  name: string;
  role: string;
  shiftStart: string;
  shiftEnd: string;
  zoneAccess: string;
  phone: string;
}

function cacheKey(eventId: string, volunteerId: string) {
  return `chaap:volunteer:${eventId}:${volunteerId}`;
}

// No login — this URL (sent once via WhatsApp) is the credential, same
// trust model as the API route it calls. "Works offline" is handled here,
// not by the PWA shell alone: the first load needs a connection (the
// volunteer is opening a link they just received), but the fetched data is
// cached to localStorage so every later open of the same link — on the
// same phone, with no signal at the venue — renders from cache instead of
// a network error.
export default function VolunteerPortalPage() {
  const { eventId: rawEventId, volunteerId: rawVolunteerId } = useParams<{ eventId: string; volunteerId: string }>();
  const eventId = decodeURIComponent(rawEventId);
  const volunteerId = decodeURIComponent(rawVolunteerId);

  const [data, setData] = useState<VolunteerPortalData | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const key = cacheKey(eventId, volunteerId);

    async function load() {
      try {
        const res = await fetch(`/api/volunteer/${eventId}/${volunteerId}`, { cache: "no-store" });
        const body = await res.json();
        if (!res.ok || !body.ok) throw new Error(body.reason ?? "NOT_FOUND");
        if (cancelled) return;
        setData(body);
        try {
          localStorage.setItem(key, JSON.stringify(body));
        } catch {
          // Private browsing / storage blocked — the portal still rendered
          // from the network response this time, just won't work offline.
        }
      } catch {
        if (cancelled) return;
        try {
          const cached = localStorage.getItem(key);
          if (cached) {
            setData(JSON.parse(cached));
            return;
          }
        } catch {
          // fall through to the error state below
        }
        setError("Couldn't load your volunteer details. Check your connection and try again.");
      }
    }

    load();
    return () => {
      cancelled = true;
    };
  }, [eventId, volunteerId]);

  if (error) {
    return (
      <div className="mx-auto max-w-sm px-4 py-16 text-center">
        <p className="font-semibold">{error}</p>
      </div>
    );
  }

  if (!data) {
    return <div className="mx-auto max-w-sm px-4 py-16 text-center text-muted">Loading…</div>;
  }

  return (
    <div className="mx-auto max-w-sm px-4 pb-20 pt-8 sm:px-6">
      <p className="text-sm text-muted">{data.eventTitle}</p>
      <h1 className="mt-1 text-2xl font-bold">{data.name}</h1>
      <p className="text-muted">{data.role}</p>

      <div className="card mt-5 p-5">
        <div className="flex justify-center">
          <TicketQr code={data.phone} />
        </div>
        <p className="mt-3 text-center text-xs text-muted">Show this at staff entry points.</p>
      </div>

      <div className="card mt-4 space-y-2 p-5 text-sm">
        <div className="flex justify-between">
          <span className="text-muted">Shift start</span>
          <span className="font-mono">{formatDateTime(data.shiftStart)}</span>
        </div>
        <div className="flex justify-between">
          <span className="text-muted">Shift end</span>
          <span className="font-mono">
            {new Date(data.shiftEnd).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" })}
          </span>
        </div>
        <div className="flex justify-between">
          <span className="text-muted">Zone access</span>
          <span className="font-mono">{data.zoneAccess || "—"}</span>
        </div>
      </div>
    </div>
  );
}
