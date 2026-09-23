"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { db, newLocalId, type LocalEvent } from "@/lib/db";
import { queueOp, useOnlineStatus } from "@/lib/sync-engine";
import { useAppSession } from "@/lib/use-app-session";
import { slugify } from "@/lib/format";
import { CURRENCIES, DEFAULT_CURRENCY } from "@/lib/currency";
import { FormSection } from "@/components/FormSection";

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
  const [submitAttempted, setSubmitAttempted] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [drafting, setDrafting] = useState(false);
  const [draftError, setDraftError] = useState<string | null>(null);
  const isOnline = useOnlineStatus();

  // Inline validation — a red ring on the specific empty field, not just a
  // banner at the bottom, once the organiser has tried to submit once.
  const invalidClass = (isValid: boolean) =>
    submitAttempted && !isValid ? "!border-danger focus:!ring-danger" : "";

  useEffect(() => {
    if (status !== "loading" && !user) router.push("/login?callbackUrl=/dashboard/events/new");
  }, [status, user, router]);

  if (!user) return null;

  function updateTicketType(key: string, patch: Partial<DraftTicketType>) {
    setTicketTypes((rows) => rows.map((r) => (r.key === key ? { ...r, ...patch } : r)));
  }

  // Not queueOp'd — this needs a live, synchronous round-trip (a draft is
  // useless offline, and there's nothing to sync; it only populates a text
  // field the organizer still explicitly submits via the existing
  // CREATE_EVENT queueOp flow below). Same direct-fetch pattern as photo
  // upload in edit/page.tsx's onPhotoSelected.
  async function draftDescription() {
    setDraftError(null);
    if (!title.trim() || !venue.trim() || !city.trim()) {
      setDraftError("Fill in the title, venue, and city first.");
      return;
    }
    setDrafting(true);
    try {
      const res = await fetch("/api/ai/event-description", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title: title.trim(),
          category,
          venue: venue.trim(),
          city: city.trim(),
          startsAt: startsAt ? new Date(startsAt).toISOString() : undefined,
        }),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok || !data?.ok) {
        setDraftError(
          data?.reason === "AI_NOT_CONFIGURED"
            ? "AI assist isn't set up on this deployment yet."
            : "Couldn't draft a description — try again."
        );
        return;
      }
      setDescription(data.description);
    } catch {
      setDraftError("Couldn't reach the server — check your connection.");
    } finally {
      setDrafting(false);
    }
  }

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setSubmitAttempted(true);
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
      // Fast-track opt-in is set via Edit once the event exists — a ticket
      // type named "VIP" already fast-tracks by name (see
      // isFastTrackTicketType) without needing this flag at creation time.
      isFastTrack: false,
      // Dynamic pricing is configured via Edit once the event exists — same
      // reasoning as isFastTrack above.
      pricingStrategy: "FIXED" as const,
      pricingTiers: [],
      // Physical capacity (crowd-density monitoring) is configured via Edit
      // once the event exists — same reasoning as isFastTrack above.
      physicalCapacity: null,
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
      // End date and wristband carry-over are configurable via Edit once
      // the event exists — same reasoning as vendorApplicationsOpen below.
      endsAt: null,
      imageUrl,
      status: "LIVE",
      currency,
      carryOverEnabled: false,
      // Race type/timing are configurable via Edit once the event exists —
      // same reasoning as endsAt above.
      eventType: "GENERAL",
      gunStartAt: null,
      // Vendor applications are off by default — configurable via Edit
      // once the event exists.
      vendorApplicationsOpen: false,
      vendorStallFeeCents: 0,
      // Same "configurable via Edit once the event exists" reasoning above.
      waitlistEnabled: false,
      organizationId: user.organizationId,
      organizerName: user.organizationName ?? user.name ?? "",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      ticketTypes: localTicketTypes,
      vendors: [],
      // Registration questions/waiver are configurable via Edit once the
      // event exists — same reasoning as vendorApplicationsOpen above.
      waiverText: null,
      registrationQuestions: [],
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

      <form onSubmit={onSubmit} className="card space-y-6 p-5 sm:p-6">
        <FormSection title="Basic details">
          <div>
            <label className="label" htmlFor="title">Event title <span className="text-danger">*</span></label>
            <input
              id="title"
              className={`input ${invalidClass(!!title.trim())}`}
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              required
            />
          </div>

          <div>
            <div className="mb-1 flex items-center justify-between">
              <label className="label !mb-0" htmlFor="description">Description</label>
              <button
                type="button"
                className="text-xs font-medium text-accent-hover disabled:opacity-50"
                onClick={draftDescription}
                disabled={drafting || !isOnline}
                title={!isOnline ? "Needs a connection" : undefined}
              >
                {drafting ? "Drafting…" : "Draft with AI"}
              </button>
            </div>
            <textarea
              id="description"
              className="input min-h-24"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
            />
            {draftError && <p className="mt-1 text-xs text-danger">{draftError}</p>}
          </div>

          <div>
            <label className="label" htmlFor="category">Category</label>
            <select id="category" className="input" value={category} onChange={(e) => setCategory(e.target.value)}>
              {CATEGORIES.map((c) => (
                <option key={c} value={c}>{c}</option>
              ))}
            </select>
          </div>
        </FormSection>

        <FormSection title="Schedule & location">
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <div>
              <label className="label" htmlFor="startsAt">Date & time <span className="text-danger">*</span></label>
              <input
                id="startsAt"
                type="datetime-local"
                className={`input ${invalidClass(!!startsAt)}`}
                value={startsAt}
                onChange={(e) => setStartsAt(e.target.value)}
                required
              />
            </div>
            <div>
              <label className="label" htmlFor="venue">Venue <span className="text-danger">*</span></label>
              <input
                id="venue"
                className={`input ${invalidClass(!!venue.trim())}`}
                value={venue}
                onChange={(e) => setVenue(e.target.value)}
                required
              />
            </div>
          </div>
          <div>
            <label className="label" htmlFor="city">City <span className="text-danger">*</span></label>
            <input
              id="city"
              className={`input ${invalidClass(!!city.trim())}`}
              value={city}
              onChange={(e) => setCity(e.target.value)}
              required
            />
          </div>
        </FormSection>

        <FormSection title="Pricing">
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
              <label className="label !mb-0">
                Ticket types <span className="text-danger">*</span>
              </label>
              <button
                type="button"
                className="text-xs font-medium text-accent-hover"
                onClick={() => setTicketTypes((rows) => [...rows, newDraftTicketType()])}
              >
                + Add ticket type
              </button>
            </div>
            {submitAttempted && ticketTypes.every((t) => !(t.name.trim() && t.priceMajor && t.quantity)) && (
              <p className="mb-2 text-xs text-danger">Add at least one complete ticket type.</p>
            )}
            <div className="space-y-3">
              {ticketTypes.map((t) => (
                <div key={t.key} className="grid grid-cols-2 gap-2 rounded-lg border border-border p-3 sm:grid-cols-[1fr_110px_80px_auto] sm:border-0 sm:p-0">
                  <input
                    placeholder="Name (e.g. General Admission)"
                    className="input col-span-2 sm:col-span-1"
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
                    className="text-xs text-muted hover:text-danger disabled:opacity-30"
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
        </FormSection>

        {error && <p className="text-sm text-danger">{error}</p>}

        <button type="submit" disabled={submitting} className="btn-primary w-full">
          {submitting ? "Creating…" : "Create event"}
        </button>
      </form>
    </div>
  );
}
