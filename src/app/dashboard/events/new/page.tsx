"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { db, newLocalId, type LocalEvent } from "@/lib/db";
import { queueOp } from "@/lib/sync-engine";
import { useAppSession } from "@/lib/use-app-session";
import { slugify } from "@/lib/format";
import { CURRENCIES, DEFAULT_CURRENCY } from "@/lib/currency";

interface DraftTicketType {
  key: string;
  name: string;
  priceMajor: string;
  quantity: string;
}

const CATEGORIES = ["Music", "Sports", "Comedy", "Conference", "Festival", "Other"];

function newDraftTicketType(): DraftTicketType {
  return { key: crypto.randomUUID(), name: "", priceMajor: "", quantity: "" };
}

export default function NewEventPage() {
  const router = useRouter();
  const { user, status } = useAppSession();

  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [category, setCategory] = useState(CATEGORIES[0]);
  const [currency, setCurrency] = useState(DEFAULT_CURRENCY);
  const [venue, setVenue] = useState("");
  const [city, setCity] = useState("");
  const [startsAt, setStartsAt] = useState("");
  const [imageSeed, setImageSeed] = useState(() => crypto.randomUUID().slice(0, 8));
  const [ticketTypes, setTicketTypes] = useState<DraftTicketType[]>([newDraftTicketType()]);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (status !== "loading" && !user) router.push("/login?callbackUrl=/dashboard/events/new");
  }, [status, user, router]);

  if (!user) return null;

  function updateTicketType(key: string, patch: Partial<DraftTicketType>) {
    setTicketTypes((rows) => rows.map((r) => (r.key === key ? { ...r, ...patch } : r)));
  }

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (!user) return;

    const validTypes = ticketTypes.filter((t) => t.name.trim() && t.priceMajor && t.quantity);
    if (!title.trim() || !venue.trim() || !city.trim() || !startsAt || validTypes.length === 0) {
      setError("Fill in the event details and at least one ticket type.");
      return;
    }

    setSubmitting(true);
    const eventClientId = newLocalId();
    const imageUrl = `https://picsum.photos/seed/${imageSeed}/1200/675`;

    const localTicketTypes = validTypes.map((t) => ({
      id: newLocalId(),
      clientId: newLocalId(),
      name: t.name.trim(),
      description: "",
      priceCents: Math.round(parseFloat(t.priceMajor) * 100),
      quantityTotal: parseInt(t.quantity, 10),
      quantitySold: 0,
    }));

    const localEvent: LocalEvent = {
      id: eventClientId,
      clientId: eventClientId,
      slug: `${slugify(title)}-${eventClientId.slice(-6)}`,
      title: title.trim(),
      description: description.trim(),
      category,
      venue: venue.trim(),
      city: city.trim(),
      startsAt: new Date(startsAt).toISOString(),
      imageUrl,
      status: "LIVE",
      currency,
      organizerId: user.id,
      organizerName: user.name ?? "",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      ticketTypes: localTicketTypes,
      syncStatus: "pending",
    };

    await db.events.put(localEvent);
    await queueOp("CREATE_EVENT", {
      eventId: eventClientId,
      title: localEvent.title,
      description: localEvent.description,
      category: localEvent.category,
      venue: localEvent.venue,
      city: localEvent.city,
      startsAt: localEvent.startsAt,
      imageUrl: localEvent.imageUrl,
      currency,
      ticketTypes: localTicketTypes.map((t) => ({
        clientId: t.clientId,
        name: t.name,
        description: t.description,
        priceCents: t.priceCents,
        quantityTotal: t.quantityTotal,
      })),
    });

    setSubmitting(false);
    router.push(`/dashboard/events/${eventClientId}`);
  }

  return (
    <div className="mx-auto max-w-2xl px-4 pb-20 pt-8 sm:px-6">
      <h1 className="mb-1 text-2xl font-bold">Create an event</h1>
      <p className="mb-6 text-sm text-muted">
        Works offline — your event saves to this device immediately and syncs
        when you&apos;re back online.
      </p>

      <form onSubmit={onSubmit} className="card space-y-5 p-6">
        <div>
          <label className="label" htmlFor="title">Event title</label>
          <input id="title" className="input" value={title} onChange={(e) => setTitle(e.target.value)} required />
        </div>

        <div>
          <label className="label" htmlFor="description">Description</label>
          <textarea
            id="description"
            className="input min-h-24"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
          />
        </div>

        <div className="grid grid-cols-2 gap-4">
          <div>
            <label className="label" htmlFor="category">Category</label>
            <select id="category" className="input" value={category} onChange={(e) => setCategory(e.target.value)}>
              {CATEGORIES.map((c) => (
                <option key={c} value={c}>{c}</option>
              ))}
            </select>
          </div>
          <div>
            <label className="label" htmlFor="startsAt">Date & time</label>
            <input
              id="startsAt"
              type="datetime-local"
              className="input"
              value={startsAt}
              onChange={(e) => setStartsAt(e.target.value)}
              required
            />
          </div>
        </div>

        <div className="grid grid-cols-2 gap-4">
          <div>
            <label className="label" htmlFor="venue">Venue</label>
            <input id="venue" className="input" value={venue} onChange={(e) => setVenue(e.target.value)} required />
          </div>
          <div>
            <label className="label" htmlFor="city">City</label>
            <input id="city" className="input" value={city} onChange={(e) => setCity(e.target.value)} required />
          </div>
        </div>

        <div>
          <label className="label" htmlFor="currency">Currency</label>
          <select id="currency" className="input" value={currency} onChange={(e) => setCurrency(e.target.value)}>
            {CURRENCIES.map((c) => (
              <option key={c.code} value={c.code}>{c.label}</option>
            ))}
          </select>
          <p className="mt-1 text-xs text-muted">All ticket types share this currency. Can&apos;t be changed once tickets sell.</p>
        </div>

        <div>
          <div className="mb-2 flex items-center justify-between">
            <label className="label !mb-0">Ticket types</label>
            <button
              type="button"
              className="text-xs font-medium text-accent-hover"
              onClick={() => setTicketTypes((rows) => [...rows, newDraftTicketType()])}
            >
              + Add ticket type
            </button>
          </div>
          <div className="space-y-3">
            {ticketTypes.map((t) => (
              <div key={t.key} className="grid grid-cols-[1fr_120px_80px_auto] items-center gap-2">
                <input
                  placeholder="Name (e.g. General Admission)"
                  className="input"
                  value={t.name}
                  onChange={(e) => updateTicketType(t.key, { name: e.target.value })}
                />
                <input
                  placeholder={`Price (${currency})`}
                  type="number"
                  min="0"
                  step="500"
                  className="input"
                  value={t.priceMajor}
                  onChange={(e) => updateTicketType(t.key, { priceMajor: e.target.value })}
                />
                <input
                  placeholder="Qty"
                  type="number"
                  min="1"
                  className="input"
                  value={t.quantity}
                  onChange={(e) => updateTicketType(t.key, { quantity: e.target.value })}
                />
                <button
                  type="button"
                  className="text-xs text-muted hover:text-danger"
                  onClick={() => setTicketTypes((rows) => rows.filter((r) => r.key !== t.key))}
                  disabled={ticketTypes.length === 1}
                >
                  Remove
                </button>
              </div>
            ))}
          </div>
        </div>

        <div>
          <button
            type="button"
            className="text-xs font-medium text-accent-hover"
            onClick={() => setImageSeed(crypto.randomUUID().slice(0, 8))}
          >
            Shuffle cover image
          </button>
        </div>

        {error && <p className="text-sm text-danger">{error}</p>}

        <button type="submit" disabled={submitting} className="btn-primary w-full">
          {submitting ? "Creating…" : "Create event"}
        </button>
      </form>
    </div>
  );
}
