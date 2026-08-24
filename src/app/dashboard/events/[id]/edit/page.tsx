"use client";

import { useEffect, useState } from "react";
import { useLiveQuery } from "dexie-react-hooks";
import { useParams, useRouter } from "next/navigation";
import Link from "next/link";
import { db, newLocalId } from "@/lib/db";
import { queueOp } from "@/lib/sync-engine";
import { useAppSession } from "@/lib/use-app-session";
import { CURRENCIES, DEFAULT_CURRENCY } from "@/lib/currency";

interface DraftTicketType {
  key: string;
  id?: string;
  clientId: string;
  name: string;
  priceMajor: string;
  quantity: string;
  quantitySold: number;
}

const CATEGORIES = ["Music", "Sports", "Comedy", "Conference", "Festival", "Other"];

function isoToLocalInput(iso: string) {
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export default function EditEventPage() {
  const { id: rawId } = useParams<{ id: string }>();
  const id = decodeURIComponent(rawId);
  const router = useRouter();
  const { user, status } = useAppSession();

  const event = useLiveQuery(async () => {
    const byId = await db.events.get(id);
    return byId ?? (await db.events.where("clientId").equals(id).first()) ?? null;
  }, [id]);

  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [category, setCategory] = useState(CATEGORIES[0]);
  const [currency, setCurrency] = useState(DEFAULT_CURRENCY);
  const [venue, setVenue] = useState("");
  const [city, setCity] = useState("");
  const [startsAt, setStartsAt] = useState("");
  const [ticketTypes, setTicketTypes] = useState<DraftTicketType[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);

  async function onPhotoSelected(file: File | undefined) {
    if (!file || !event) return;
    setUploadError(null);
    setUploading(true);
    try {
      const formData = new FormData();
      formData.append("file", file);
      const res = await fetch("/api/upload", { method: "POST", body: formData });
      const data = await res.json();
      if (!res.ok || !data.ok) {
        setUploadError(
          data.reason === "UPLOAD_NOT_CONFIGURED"
            ? "Photo upload isn't set up on this deployment yet."
            : "Couldn't upload that photo."
        );
        return;
      }
      await db.events.put({ ...event, imageUrl: data.url, syncStatus: "pending" });
      await queueOp("EDIT_EVENT", { eventId: event.id, eventClientId: event.clientId, imageUrl: data.url });
    } catch {
      setUploadError("Couldn't reach the server — try again once you're online.");
    } finally {
      setUploading(false);
    }
  }

  useEffect(() => {
    if (status !== "loading" && !user) router.push(`/login?callbackUrl=/dashboard/events/${id}/edit`);
  }, [status, user, router, id]);

  useEffect(() => {
    if (event && !loaded) {
      setTitle(event.title);
      setDescription(event.description);
      setCategory(event.category);
      setCurrency(event.currency);
      setVenue(event.venue);
      setCity(event.city);
      setStartsAt(isoToLocalInput(event.startsAt));
      setTicketTypes(
        event.ticketTypes.map((tt) => ({
          key: tt.id,
          id: tt.id,
          clientId: tt.clientId ?? tt.id,
          name: tt.name,
          priceMajor: String(tt.priceCents / 100),
          quantity: String(tt.quantityTotal),
          quantitySold: tt.quantitySold,
        }))
      );
      setLoaded(true);
    }
  }, [event, loaded]);

  if (!user) return null;

  if (event === undefined || !loaded) {
    return <div className="mx-auto max-w-2xl px-4 py-16 text-center text-muted">Loading…</div>;
  }

  if (!event) {
    return (
      <div className="mx-auto max-w-2xl px-4 py-16 text-center">
        <p className="font-semibold">Event not found on this device.</p>
        <Link href="/dashboard" className="btn-secondary mt-6 inline-flex">Back to dashboard</Link>
      </div>
    );
  }

  if (event.organizerId !== user.id) {
    return (
      <div className="mx-auto max-w-2xl px-4 py-16 text-center">
        <p className="font-semibold">You don&apos;t manage this event.</p>
        <Link href="/dashboard" className="btn-secondary mt-6 inline-flex">Back to dashboard</Link>
      </div>
    );
  }

  const currencyLocked = event.ticketTypes.some((tt) => tt.quantitySold > 0);

  function updateTicketType(key: string, patch: Partial<DraftTicketType>) {
    setTicketTypes((rows) => rows.map((r) => (r.key === key ? { ...r, ...patch } : r)));
  }

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (!event) return;

    const validTypes = ticketTypes.filter((t) => t.name.trim() && t.priceMajor && t.quantity);
    if (!title.trim() || !venue.trim() || !city.trim() || !startsAt || validTypes.length === 0) {
      setError("Fill in the event details and at least one ticket type.");
      return;
    }
    for (const t of validTypes) {
      if (parseInt(t.quantity, 10) < t.quantitySold) {
        setError(`"${t.name}" already has ${t.quantitySold} sold — quantity can't go below that.`);
        return;
      }
    }

    setSubmitting(true);

    // For local storage every ticket type needs a stable string id — reuse
    // the real server id when editing an existing one, otherwise the
    // client-generated id doubles as a placeholder until it syncs (same
    // pattern as creating a brand new event).
    const localTicketTypes = validTypes.map((t) => ({
      id: t.id ?? t.clientId,
      clientId: t.clientId,
      name: t.name.trim(),
      description: "",
      priceCents: Math.round(parseFloat(t.priceMajor) * 100),
      quantityTotal: parseInt(t.quantity, 10),
      quantitySold: t.quantitySold,
    }));

    // The server payload keeps `id` genuinely undefined for new ticket
    // types so it knows to create rather than update.
    const payloadTicketTypes = validTypes.map((t) => ({
      id: t.id,
      clientId: t.clientId,
      name: t.name.trim(),
      description: "",
      priceCents: Math.round(parseFloat(t.priceMajor) * 100),
      quantityTotal: parseInt(t.quantity, 10),
    }));

    await db.events.put({
      ...event,
      title: title.trim(),
      description: description.trim(),
      category,
      currency,
      venue: venue.trim(),
      city: city.trim(),
      startsAt: new Date(startsAt).toISOString(),
      ticketTypes: [
        ...event.ticketTypes.filter((tt) => !localTicketTypes.some((u) => u.id === tt.id)),
        ...localTicketTypes,
      ],
      syncStatus: "pending",
    });

    await queueOp("EDIT_EVENT", {
      eventId: event.id,
      eventClientId: event.clientId,
      title: title.trim(),
      description: description.trim(),
      category,
      currency,
      venue: venue.trim(),
      city: city.trim(),
      startsAt: new Date(startsAt).toISOString(),
      ticketTypes: payloadTicketTypes.map((t) => ({
        id: t.id,
        clientId: t.clientId,
        name: t.name,
        description: t.description,
        priceCents: t.priceCents,
        quantityTotal: t.quantityTotal,
      })),
    });

    setSubmitting(false);
    router.push(`/dashboard/events/${event.id}`);
  }

  return (
    <div className="mx-auto max-w-2xl px-4 pb-20 pt-8 sm:px-6">
      <Link href={`/dashboard/events/${event.id}`} className="text-sm text-muted hover:text-foreground">
        ← {event.title}
      </Link>
      <h1 className="mb-1 mt-3 text-2xl font-bold">Edit event</h1>
      <p className="mb-6 text-sm text-muted">
        Works offline — changes save to this device immediately and sync when
        you&apos;re back online.
      </p>

      <div className="card mb-5 p-6">
        <label className="label">Cover photo</label>
        <div className="overflow-hidden rounded-lg border border-border">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={event.imageUrl} alt="" className="h-40 w-full object-cover" />
        </div>
        <label className="btn-secondary mt-3 inline-flex cursor-pointer">
          {uploading ? "Uploading…" : "Upload a new photo"}
          <input
            type="file"
            accept="image/jpeg,image/png,image/webp"
            className="hidden"
            disabled={uploading}
            onChange={(e) => onPhotoSelected(e.target.files?.[0])}
          />
        </label>
        {uploadError && <p className="mt-2 text-sm text-danger">{uploadError}</p>}
        <p className="mt-2 text-xs text-muted">Requires a connection — the placeholder stays until you upload one.</p>
      </div>

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
          <select
            id="currency"
            className="input disabled:cursor-not-allowed disabled:opacity-50"
            value={currency}
            onChange={(e) => setCurrency(e.target.value)}
            disabled={currencyLocked}
          >
            {CURRENCIES.map((c) => (
              <option key={c.code} value={c.code}>{c.label}</option>
            ))}
          </select>
          <p className="mt-1 text-xs text-muted">
            {currencyLocked
              ? "Locked — this event already has ticket sales, so changing currency would make past totals wrong."
              : "All ticket types share this currency."}
          </p>
        </div>

        <div>
          <div className="mb-2 flex items-center justify-between">
            <label className="label !mb-0">Ticket types</label>
            <button
              type="button"
              className="text-xs font-medium text-accent-hover"
              onClick={() =>
                setTicketTypes((rows) => [
                  ...rows,
                  { key: crypto.randomUUID(), clientId: newLocalId(), name: "", priceMajor: "", quantity: "", quantitySold: 0 },
                ])
              }
            >
              + Add ticket type
            </button>
          </div>
          <div className="space-y-3">
            {ticketTypes.map((t) => (
              <div key={t.key} className="grid grid-cols-[1fr_120px_80px_auto] items-center gap-2">
                <input
                  placeholder="Name"
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
                  min={t.quantitySold || 1}
                  className="input"
                  value={t.quantity}
                  onChange={(e) => updateTicketType(t.key, { quantity: e.target.value })}
                />
                <button
                  type="button"
                  className="text-xs text-muted hover:text-danger disabled:opacity-30"
                  onClick={() => setTicketTypes((rows) => rows.filter((r) => r.key !== t.key))}
                  disabled={ticketTypes.length === 1 || t.quantitySold > 0}
                  title={t.quantitySold > 0 ? "Can't remove a ticket type that's already sold" : undefined}
                >
                  Remove
                </button>
                {t.quantitySold > 0 && (
                  <p className="col-span-4 -mt-1 text-xs text-muted">{t.quantitySold} already sold</p>
                )}
              </div>
            ))}
          </div>
        </div>

        {error && <p className="text-sm text-danger">{error}</p>}

        <button type="submit" disabled={submitting} className="btn-primary w-full">
          {submitting ? "Saving…" : "Save changes"}
        </button>
      </form>
    </div>
  );
}
