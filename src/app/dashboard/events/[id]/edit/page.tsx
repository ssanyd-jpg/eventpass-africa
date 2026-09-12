"use client";

import { useEffect, useState } from "react";
import { useLiveQuery } from "dexie-react-hooks";
import { useParams, useRouter } from "next/navigation";
import Link from "next/link";
import { db, newLocalId, type LocalDiscountCode } from "@/lib/db";
import { queueOp, useOnlineStatus } from "@/lib/sync-engine";
import { useAppSession } from "@/lib/use-app-session";
import { CURRENCIES, DEFAULT_CURRENCY } from "@/lib/currency";
import { eventHasEnded } from "@/lib/carry-over";

interface DraftTicketType {
  key: string;
  id?: string;
  clientId: string;
  name: string;
  priceMajor: string;
  quantity: string;
  quantitySold: number;
  // Session 14 — explicit VIP fast-track opt-in, independent of name.
  isFastTrack: boolean;
}

interface DraftQuestion {
  key: string;
  id?: string;
  clientId: string;
  label: string;
  type: "TEXT" | "SELECT" | "CHECKBOX";
  options: string;
  required: boolean;
}

interface DraftDiscountCode {
  key: string;
  id?: string;
  clientId: string;
  code: string;
  type: "PERCENT_OFF" | "FIXED_AMOUNT_OFF";
  // References a ticketTypes[] draft row by its key — resolved to a real
  // id-or-clientId at submit time, since the row it targets may be a brand
  // new ticket type created in this very same save.
  ticketTypeKey: string;
  percentOffMajor: string; // "10" means 10%
  amountOffMajor: string; // major-unit currency string, e.g. "5.00"
  maxRedemptions: string;
  active: boolean;
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

  // Organizer-only, so it lives in its own Dexie table (populated from
  // payload.myDiscountCodes) rather than nested on LocalEvent the way
  // ticketTypes is — see the LocalDiscountCode comment in src/lib/db.ts for
  // why discount codes must not ride in the public event pull.
  const existingDiscountCodes = useLiveQuery(async () => {
    if (!event) return undefined;
    return db.discountCodes.where("eventId").equals(event.id).toArray();
  }, [event?.id]);

  // Same organizer-only split as discountCodes — survey questions must not
  // ride in the public event pull either (see LocalSurveyQuestion).
  const existingSurveyQuestions = useLiveQuery(async () => {
    if (!event) return undefined;
    return db.surveyQuestions.where("eventId").equals(event.id).toArray();
  }, [event?.id]);

  // Session 11 — the carry-over toggle is only meaningful once the
  // organisation has run at least one event that has ended (a wallet from
  // it could carry a balance forward).
  const hasPastCompletedEvent = useLiveQuery(async () => {
    if (!event) return false;
    const all = await db.events.toArray();
    return all.some(
      (e) => e.organizationId === event.organizationId && e.id !== event.id && e.status !== "CANCELLED" && eventHasEnded(e)
    );
  }, [event?.id, event?.organizationId]);

  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [category, setCategory] = useState(CATEGORIES[0]);
  const [currency, setCurrency] = useState(DEFAULT_CURRENCY);
  const [venue, setVenue] = useState("");
  const [city, setCity] = useState("");
  const [startsAt, setStartsAt] = useState("");
  const [endsAt, setEndsAt] = useState("");
  const [carryOverEnabled, setCarryOverEnabled] = useState(false);
  const [eventType, setEventType] = useState<"GENERAL" | "MARATHON" | "CONFERENCE" | "FOOTBALL">("GENERAL");
  const [ticketTypes, setTicketTypes] = useState<DraftTicketType[]>([]);
  const [vendorApplicationsOpen, setVendorApplicationsOpen] = useState(false);
  const [vendorStallFeeMajor, setVendorStallFeeMajor] = useState("0");
  const [questions, setQuestions] = useState<DraftQuestion[]>([]);
  const [surveyQuestions, setSurveyQuestions] = useState<DraftQuestion[]>([]);
  const [discountCodes, setDiscountCodes] = useState<DraftDiscountCode[]>([]);
  const [waiverText, setWaiverText] = useState("");
  const [loaded, setLoaded] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [drafting, setDrafting] = useState(false);
  const [draftError, setDraftError] = useState<string | null>(null);
  const isOnline = useOnlineStatus();

  // Not queueOp'd — needs a live, synchronous round-trip (a draft is
  // useless offline; it only populates a text field the organizer still
  // explicitly submits via the existing EDIT_EVENT queueOp flow below).
  // Same direct-fetch pattern as onPhotoSelected just above.
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
    if (event && existingDiscountCodes !== undefined && existingSurveyQuestions !== undefined && !loaded) {
      setTitle(event.title);
      setDescription(event.description);
      setCategory(event.category);
      setCurrency(event.currency);
      setVenue(event.venue);
      setCity(event.city);
      setStartsAt(isoToLocalInput(event.startsAt));
      setEndsAt(event.endsAt ? isoToLocalInput(event.endsAt) : "");
      setCarryOverEnabled(event.carryOverEnabled);
      setEventType(event.eventType);
      setVendorApplicationsOpen(event.vendorApplicationsOpen);
      setVendorStallFeeMajor(String(event.vendorStallFeeCents / 100));
      setWaiverText(event.waiverText ?? "");
      setQuestions(
        (event.registrationQuestions ?? []).map((q) => ({
          key: q.id,
          id: q.id,
          clientId: q.clientId ?? q.id,
          label: q.label,
          type: q.type,
          options: q.options ?? "",
          required: q.required,
        }))
      );
      const loadedTicketTypes = event.ticketTypes.map((tt) => ({
        key: tt.id,
        id: tt.id,
        clientId: tt.clientId ?? tt.id,
        name: tt.name,
        priceMajor: String(tt.priceCents / 100),
        quantity: String(tt.quantityTotal),
        quantitySold: tt.quantitySold,
        isFastTrack: tt.isFastTrack ?? false,
      }));
      setTicketTypes(loadedTicketTypes);
      setDiscountCodes(
        existingDiscountCodes.map((dc) => ({
          key: dc.id,
          id: dc.id,
          clientId: dc.clientId ?? dc.id,
          code: dc.code,
          type: dc.type,
          ticketTypeKey: loadedTicketTypes.find((t) => t.id === dc.ticketTypeId)?.key ?? dc.ticketTypeId,
          percentOffMajor: dc.percentOff != null ? String(dc.percentOff) : "",
          amountOffMajor: dc.amountOffCents != null ? String(dc.amountOffCents / 100) : "",
          maxRedemptions: dc.maxRedemptions != null ? String(dc.maxRedemptions) : "",
          active: dc.active,
        }))
      );
      setSurveyQuestions(
        existingSurveyQuestions.map((q) => ({
          key: q.id,
          id: q.id,
          clientId: q.clientId ?? q.id,
          label: q.label,
          type: q.type,
          options: q.options ?? "",
          required: q.required,
        }))
      );
      setLoaded(true);
    }
  }, [event, existingDiscountCodes, existingSurveyQuestions, loaded]);

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

  if (event.organizationId !== user.organizationId) {
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

  function updateQuestion(key: string, patch: Partial<DraftQuestion>) {
    setQuestions((rows) => rows.map((r) => (r.key === key ? { ...r, ...patch } : r)));
  }

  function updateSurveyQuestion(key: string, patch: Partial<DraftQuestion>) {
    setSurveyQuestions((rows) => rows.map((r) => (r.key === key ? { ...r, ...patch } : r)));
  }

  function updateDiscountCode(key: string, patch: Partial<DraftDiscountCode>) {
    setDiscountCodes((rows) => rows.map((r) => (r.key === key ? { ...r, ...patch } : r)));
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

    const validQuestions = questions.filter((q) => q.label.trim());
    const validSurveyQuestions = surveyQuestions.filter((q) => q.label.trim());

    const validDiscountCodes = discountCodes.filter((d) => d.code.trim());
    for (const d of validDiscountCodes) {
      if (d.code.trim().length < 3) {
        setError(`Discount code "${d.code}" needs at least 3 characters.`);
        return;
      }
      if (!ticketTypes.some((t) => t.key === d.ticketTypeKey)) {
        setError(`Discount code "${d.code}" needs a ticket type selected.`);
        return;
      }
      if (d.type === "PERCENT_OFF" && !d.percentOffMajor) {
        setError(`Discount code "${d.code}" needs a percentage.`);
        return;
      }
      if (d.type === "FIXED_AMOUNT_OFF" && !d.amountOffMajor) {
        setError(`Discount code "${d.code}" needs an amount.`);
        return;
      }
    }

    setSubmitting(true);

    // Local storage needs a definite id (fall back to clientId as a
    // placeholder until it syncs, same as ticketTypes above); the wire
    // payload keeps `id` genuinely undefined for new questions so the
    // server knows to create rather than update — otherwise one shared
    // shape, since nothing about a question is server-derived.
    const localQuestions = validQuestions.map((q, index) => ({
      id: q.id ?? q.clientId,
      clientId: q.clientId,
      label: q.label.trim(),
      type: q.type,
      options: q.type === "SELECT" ? q.options.trim() : null,
      required: q.required,
      sortOrder: index,
    }));
    const payloadQuestions = validQuestions.map((q, index) => ({
      id: q.id,
      clientId: q.clientId,
      label: q.label.trim(),
      type: q.type,
      options: q.type === "SELECT" ? q.options.trim() : undefined,
      required: q.required,
      sortOrder: index,
    }));

    // Identical local/payload shapes as registrationQuestions above — see
    // SurveyQuestion's schema comment for why they share this exact shape.
    const localSurveyQuestions = validSurveyQuestions.map((q, index) => ({
      id: q.id ?? q.clientId,
      clientId: q.clientId,
      eventId: event.id,
      label: q.label.trim(),
      type: q.type,
      options: q.type === "SELECT" ? q.options.trim() : null,
      required: q.required,
      sortOrder: index,
      createdAt: existingSurveyQuestions?.find((e) => e.id === q.id)?.createdAt ?? new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }));
    const payloadSurveyQuestions = validSurveyQuestions.map((q, index) => ({
      id: q.id,
      clientId: q.clientId,
      label: q.label.trim(),
      type: q.type,
      options: q.type === "SELECT" ? q.options.trim() : undefined,
      required: q.required,
      sortOrder: index,
    }));

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
      isFastTrack: t.isFastTrack,
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
      isFastTrack: t.isFastTrack,
    }));

    const vendorStallFeeCents = Math.round(parseFloat(vendorStallFeeMajor || "0") * 100);

    // ticketTypeKey references a ticketTypes[] draft row by its key — this
    // resolves it to the id-or-clientId the server actually understands
    // (handleEditEvent resolves a clientId reference to a real id after its
    // own ticketTypes upsert, in the same save — see the cross-reference-
    // resolution note in sync-handlers.ts).
    const resolveTicketTypeId = (key: string) => {
      const t = ticketTypes.find((tt) => tt.key === key);
      return t ? t.id ?? t.clientId : key;
    };

    const localDiscountCodes: LocalDiscountCode[] = validDiscountCodes.map((d) => {
      const tt = ticketTypes.find((t) => t.key === d.ticketTypeKey);
      const existing = existingDiscountCodes?.find((e) => e.id === d.id);
      return {
        id: d.id ?? d.clientId,
        clientId: d.clientId,
        eventId: event.id,
        code: d.code.trim().toUpperCase(),
        type: d.type,
        percentOff: d.type === "PERCENT_OFF" ? Math.round(parseFloat(d.percentOffMajor)) : null,
        amountOffCents: d.type === "FIXED_AMOUNT_OFF" ? Math.round(parseFloat(d.amountOffMajor) * 100) : null,
        ticketTypeId: resolveTicketTypeId(d.ticketTypeKey),
        ticketTypeName: tt?.name.trim() || "",
        maxRedemptions: d.maxRedemptions ? parseInt(d.maxRedemptions, 10) : null,
        redemptionCount: existing?.redemptionCount ?? 0,
        expiresAt: existing?.expiresAt ?? null,
        active: d.active,
        createdAt: existing?.createdAt ?? new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
    });

    const payloadDiscountCodes = validDiscountCodes.map((d) => ({
      id: d.id,
      clientId: d.clientId,
      code: d.code.trim().toUpperCase(),
      type: d.type,
      ticketTypeId: resolveTicketTypeId(d.ticketTypeKey),
      percentOff: d.type === "PERCENT_OFF" ? Math.round(parseFloat(d.percentOffMajor)) : undefined,
      amountOffCents: d.type === "FIXED_AMOUNT_OFF" ? Math.round(parseFloat(d.amountOffMajor) * 100) : undefined,
      maxRedemptions: d.maxRedemptions ? parseInt(d.maxRedemptions, 10) : undefined,
      active: d.active,
    }));

    if (localDiscountCodes.length > 0) {
      await db.discountCodes.bulkPut(localDiscountCodes);
    }
    if (localSurveyQuestions.length > 0) {
      await db.surveyQuestions.bulkPut(localSurveyQuestions);
    }

    await db.events.put({
      ...event,
      title: title.trim(),
      description: description.trim(),
      category,
      currency,
      venue: venue.trim(),
      city: city.trim(),
      startsAt: new Date(startsAt).toISOString(),
      endsAt: endsAt ? new Date(endsAt).toISOString() : null,
      carryOverEnabled,
      eventType,
      vendorApplicationsOpen,
      vendorStallFeeCents,
      waiverText: waiverText.trim() || null,
      ticketTypes: [
        ...event.ticketTypes.filter((tt) => !localTicketTypes.some((u) => u.id === tt.id)),
        ...localTicketTypes,
      ],
      registrationQuestions: localQuestions,
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
      endsAt: endsAt ? new Date(endsAt).toISOString() : null,
      carryOverEnabled,
      eventType,
      vendorApplicationsOpen,
      vendorStallFeeCents,
      waiverText: waiverText.trim() || null,
      ticketTypes: payloadTicketTypes.map((t) => ({
        id: t.id,
        clientId: t.clientId,
        name: t.name,
        description: t.description,
        priceCents: t.priceCents,
        quantityTotal: t.quantityTotal,
        isFastTrack: t.isFastTrack,
      })),
      registrationQuestions: payloadQuestions,
      discountCodes: payloadDiscountCodes,
      surveyQuestions: payloadSurveyQuestions,
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

        <div>
          <label className="label" htmlFor="endsAt">Ends at (optional)</label>
          <input
            id="endsAt"
            type="datetime-local"
            className="input"
            value={endsAt}
            onChange={(e) => setEndsAt(e.target.value)}
          />
          <p className="mt-1 text-xs text-muted">
            When the event is over. Used to decide when a wristband balance can carry over to a later event.
          </p>
        </div>

        <div>
          <label className="label" htmlFor="eventType">Event type</label>
          <select
            id="eventType"
            className="input"
            value={eventType}
            onChange={(e) => setEventType(e.target.value as typeof eventType)}
          >
            <option value="GENERAL">General</option>
            <option value="MARATHON">Marathon / running race</option>
            <option value="CONFERENCE">Conference</option>
            <option value="FOOTBALL">Football Match</option>
          </select>
          <p className="mt-1 text-xs text-muted">
            Marathon unlocks timing setup, a timing scanner, and a public live leaderboard.
          </p>
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
                  { key: crypto.randomUUID(), clientId: newLocalId(), name: "", priceMajor: "", quantity: "", quantitySold: 0, isFastTrack: false },
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
                <label className="col-span-4 -mt-1 flex items-center gap-2 text-xs text-muted">
                  <input
                    type="checkbox"
                    checked={t.isFastTrack}
                    onChange={(e) => updateTicketType(t.key, { isFastTrack: e.target.checked })}
                  />
                  VIP / fast-track lane at the gate
                </label>
                {t.quantitySold > 0 && (
                  <p className="col-span-4 -mt-1 text-xs text-muted">{t.quantitySold} already sold</p>
                )}
              </div>
            ))}
          </div>
        </div>

        {hasPastCompletedEvent && (
          <div className="border-t border-border pt-5">
            <label className="flex items-center gap-2">
              <input
                type="checkbox"
                checked={carryOverEnabled}
                onChange={(e) => setCarryOverEnabled(e.target.checked)}
              />
              <span className="label !mb-0">Allow wristband balance carry-over</span>
            </label>
            <p className="mt-1 text-xs text-muted">
              An attendee registering a wallet here can bring a leftover balance from a wallet at one of your
              past events, instead of requesting a refund and topping up again.
            </p>
          </div>
        )}

        <div className="border-t border-border pt-5">
          <label className="flex items-center gap-2">
            <input
              type="checkbox"
              checked={vendorApplicationsOpen}
              onChange={(e) => setVendorApplicationsOpen(e.target.checked)}
            />
            <span className="label !mb-0">Accept vendor applications</span>
          </label>
          <p className="mt-1 text-xs text-muted">
            Lets food stalls, merch tables, and other exhibitors apply to this event.
          </p>
          {vendorApplicationsOpen && (
            <div className="mt-3">
              <label className="label" htmlFor="vendorStallFee">Stall fee ({currency})</label>
              <input
                id="vendorStallFee"
                type="number"
                min="0"
                step="500"
                className="input"
                value={vendorStallFeeMajor}
                onChange={(e) => setVendorStallFeeMajor(e.target.value)}
              />
              <p className="mt-1 text-xs text-muted">0 means vendors apply for free.</p>
            </div>
          )}
        </div>

        <div className="border-t border-border pt-5">
          <div className="mb-2 flex items-center justify-between">
            <label className="label !mb-0">Registration questions</label>
            <button
              type="button"
              className="text-xs font-medium text-accent-hover"
              onClick={() =>
                setQuestions((rows) => [
                  ...rows,
                  { key: crypto.randomUUID(), clientId: newLocalId(), label: "", type: "TEXT", options: "", required: false },
                ])
              }
            >
              + Add question
            </button>
          </div>
          <p className="mb-3 text-xs text-muted">Asked once per order at checkout, before payment.</p>
          <div className="space-y-3">
            {questions.map((q) => (
              <div key={q.key} className="space-y-2 rounded-lg border border-border p-3">
                <div className="grid grid-cols-[1fr_120px_auto] items-center gap-2">
                  <input
                    placeholder="Question (e.g. Dietary requirements?)"
                    className="input"
                    value={q.label}
                    onChange={(e) => updateQuestion(q.key, { label: e.target.value })}
                  />
                  <select
                    className="input"
                    value={q.type}
                    onChange={(e) => updateQuestion(q.key, { type: e.target.value as DraftQuestion["type"] })}
                  >
                    <option value="TEXT">Text</option>
                    <option value="SELECT">Choice</option>
                    <option value="CHECKBOX">Checkbox</option>
                  </select>
                  <button
                    type="button"
                    className="text-xs text-muted hover:text-danger"
                    onClick={() => setQuestions((rows) => rows.filter((r) => r.key !== q.key))}
                  >
                    Remove
                  </button>
                </div>
                {q.type === "SELECT" && (
                  <input
                    placeholder="Options, comma-separated (e.g. Small,Medium,Large)"
                    className="input"
                    value={q.options}
                    onChange={(e) => updateQuestion(q.key, { options: e.target.value })}
                  />
                )}
                <label className="flex items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    checked={q.required}
                    onChange={(e) => updateQuestion(q.key, { required: e.target.checked })}
                  />
                  Required
                </label>
              </div>
            ))}
            {questions.length === 0 && <p className="text-sm text-muted">No questions yet.</p>}
          </div>
        </div>

        <div className="border-t border-border pt-5">
          <div className="mb-2 flex items-center justify-between">
            <label className="label !mb-0">Post-event survey questions</label>
            <button
              type="button"
              className="text-xs font-medium text-accent-hover"
              onClick={() =>
                setSurveyQuestions((rows) => [
                  ...rows,
                  { key: crypto.randomUUID(), clientId: newLocalId(), label: "", type: "TEXT", options: "", required: false },
                ])
              }
            >
              + Add question
            </button>
          </div>
          <p className="mb-3 text-xs text-muted">
            Buyers are invited to answer once the event is at least 24 hours past.
          </p>
          <div className="space-y-3">
            {surveyQuestions.map((q) => (
              <div key={q.key} className="space-y-2 rounded-lg border border-border p-3">
                <div className="grid grid-cols-[1fr_120px_auto] items-center gap-2">
                  <input
                    placeholder="Question (e.g. How was the event?)"
                    className="input"
                    value={q.label}
                    onChange={(e) => updateSurveyQuestion(q.key, { label: e.target.value })}
                  />
                  <select
                    className="input"
                    value={q.type}
                    onChange={(e) => updateSurveyQuestion(q.key, { type: e.target.value as DraftQuestion["type"] })}
                  >
                    <option value="TEXT">Text</option>
                    <option value="SELECT">Choice</option>
                    <option value="CHECKBOX">Checkbox</option>
                  </select>
                  <button
                    type="button"
                    className="text-xs text-muted hover:text-danger"
                    onClick={() => setSurveyQuestions((rows) => rows.filter((r) => r.key !== q.key))}
                  >
                    Remove
                  </button>
                </div>
                {q.type === "SELECT" && (
                  <input
                    placeholder="Options, comma-separated (e.g. Great,Okay,Poor)"
                    className="input"
                    value={q.options}
                    onChange={(e) => updateSurveyQuestion(q.key, { options: e.target.value })}
                  />
                )}
                <label className="flex items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    checked={q.required}
                    onChange={(e) => updateSurveyQuestion(q.key, { required: e.target.checked })}
                  />
                  Required
                </label>
              </div>
            ))}
            {surveyQuestions.length === 0 && <p className="text-sm text-muted">No survey questions yet.</p>}
          </div>
        </div>

        <div className="border-t border-border pt-5">
          <div className="mb-2 flex items-center justify-between">
            <label className="label !mb-0">Discount codes</label>
            <button
              type="button"
              className="text-xs font-medium text-accent-hover disabled:opacity-40"
              disabled={ticketTypes.length === 0}
              onClick={() =>
                setDiscountCodes((rows) => [
                  ...rows,
                  {
                    key: crypto.randomUUID(),
                    clientId: newLocalId(),
                    code: "",
                    type: "PERCENT_OFF",
                    ticketTypeKey: ticketTypes[0]?.key ?? "",
                    percentOffMajor: "",
                    amountOffMajor: "",
                    maxRedemptions: "",
                    active: true,
                  },
                ])
              }
            >
              + Add discount code
            </button>
          </div>
          <p className="mb-3 text-xs text-muted">
            Each code discounts one specific ticket type only.
          </p>
          <div className="space-y-3">
            {discountCodes.map((d) => (
              <div key={d.key} className="space-y-2 rounded-lg border border-border p-3">
                <div className="grid grid-cols-[1fr_1fr] gap-2">
                  <input
                    placeholder="Code (e.g. EARLYBIRD)"
                    className="input uppercase"
                    value={d.code}
                    onChange={(e) => updateDiscountCode(d.key, { code: e.target.value })}
                  />
                  <select
                    className="input"
                    value={d.ticketTypeKey}
                    onChange={(e) => updateDiscountCode(d.key, { ticketTypeKey: e.target.value })}
                  >
                    {ticketTypes.map((t) => (
                      <option key={t.key} value={t.key}>{t.name || "Untitled ticket type"}</option>
                    ))}
                  </select>
                </div>
                <div className="grid grid-cols-[140px_1fr_1fr] gap-2">
                  <select
                    className="input"
                    value={d.type}
                    onChange={(e) => updateDiscountCode(d.key, { type: e.target.value as DraftDiscountCode["type"] })}
                  >
                    <option value="PERCENT_OFF">% off</option>
                    <option value="FIXED_AMOUNT_OFF">Amount off</option>
                  </select>
                  {d.type === "PERCENT_OFF" ? (
                    <input
                      placeholder="e.g. 10"
                      type="number"
                      min="1"
                      max="100"
                      className="input"
                      value={d.percentOffMajor}
                      onChange={(e) => updateDiscountCode(d.key, { percentOffMajor: e.target.value })}
                    />
                  ) : (
                    <input
                      placeholder={`Amount (${currency})`}
                      type="number"
                      min="0"
                      step="500"
                      className="input"
                      value={d.amountOffMajor}
                      onChange={(e) => updateDiscountCode(d.key, { amountOffMajor: e.target.value })}
                    />
                  )}
                  <input
                    placeholder="Max uses (optional)"
                    type="number"
                    min="1"
                    className="input"
                    value={d.maxRedemptions}
                    onChange={(e) => updateDiscountCode(d.key, { maxRedemptions: e.target.value })}
                  />
                </div>
                <div className="flex items-center justify-between">
                  <label className="flex items-center gap-2 text-sm">
                    <input
                      type="checkbox"
                      checked={d.active}
                      onChange={(e) => updateDiscountCode(d.key, { active: e.target.checked })}
                    />
                    Active
                  </label>
                  <button
                    type="button"
                    className="text-xs text-muted hover:text-danger"
                    onClick={() => setDiscountCodes((rows) => rows.filter((r) => r.key !== d.key))}
                  >
                    Remove
                  </button>
                </div>
                {d.id && (
                  <p className="text-xs text-muted">
                    Removing this from the form won&apos;t delete or deactivate it — untick &quot;Active&quot; instead.
                  </p>
                )}
              </div>
            ))}
            {discountCodes.length === 0 && (
              <p className="text-sm text-muted">
                {ticketTypes.length === 0 ? "Add a ticket type first." : "No discount codes yet."}
              </p>
            )}
          </div>
        </div>

        <div className="border-t border-border pt-5">
          <label className="label" htmlFor="waiverText">Waiver</label>
          <textarea
            id="waiverText"
            className="input min-h-24"
            placeholder="Leave blank for no waiver."
            value={waiverText}
            onChange={(e) => setWaiverText(e.target.value)}
          />
          <p className="mt-1 text-xs text-muted">
            If set, buyers must accept this at checkout before their purchase goes through.
          </p>
        </div>

        {error && <p className="text-sm text-danger">{error}</p>}

        <button type="submit" disabled={submitting} className="btn-primary w-full">
          {submitting ? "Saving…" : "Save changes"}
        </button>
      </form>
    </div>
  );
}
