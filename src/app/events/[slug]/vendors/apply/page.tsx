"use client";

import { useState } from "react";
import { useLiveQuery } from "dexie-react-hooks";
import { useParams, useRouter } from "next/navigation";
import Link from "next/link";
import { db, newLocalId, type LocalVendor } from "@/lib/db";
import { queueOp } from "@/lib/sync-engine";
import { useAppSession } from "@/lib/use-app-session";
import { formatCents } from "@/lib/format";

const VENDOR_CATEGORIES = ["Food", "Merchandise", "Services", "Other"];

export default function ApplyVendorPage() {
  const { slug } = useParams<{ slug: string }>();
  const router = useRouter();
  const { user } = useAppSession();
  const events = useLiveQuery(() => db.events.toArray(), []);
  const event = events?.find((e) => e.slug === slug);

  const [name, setName] = useState("");
  const [category, setCategory] = useState(VENDOR_CATEGORIES[0]);
  const [description, setDescription] = useState("");
  const [contactEmail, setContactEmail] = useState("");
  const [contactPhone, setContactPhone] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [submitted, setSubmitted] = useState(false);

  if (events === undefined) {
    return <div className="mx-auto max-w-lg px-4 py-16 text-center text-muted">Loading…</div>;
  }

  if (!event) {
    return (
      <div className="mx-auto max-w-lg px-4 py-16 text-center">
        <p className="text-lg font-semibold">Event not found on this device.</p>
        <Link href="/" className="btn-secondary mt-6 inline-flex">Back to browse</Link>
      </div>
    );
  }

  if (!event.vendorApplicationsOpen) {
    return (
      <div className="mx-auto max-w-lg px-4 py-16 text-center">
        <p className="text-lg font-semibold">This event isn&apos;t accepting vendor applications.</p>
        <Link href={`/events/${slug}`} className="btn-secondary mt-6 inline-flex">← {event.title}</Link>
      </div>
    );
  }

  if (submitted) {
    return (
      <div className="mx-auto max-w-lg px-4 py-16 text-center">
        <p className="text-lg font-semibold">Application submitted</p>
        <p className="mt-2 text-sm text-muted">
          The organizer will review your application. You can check its status
          from your account.
        </p>
        <div className="mt-6 flex justify-center gap-2">
          <Link href={`/events/${slug}`} className="btn-secondary">← {event.title}</Link>
          <Link href="/account/vendor-applications" className="btn-primary">My applications</Link>
        </div>
      </div>
    );
  }

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);

    if (!user) {
      router.push(`/login?callbackUrl=/events/${slug}/vendors/apply`);
      return;
    }
    if (!event) return;
    if (!name.trim() || !contactEmail.trim() || !contactPhone.trim()) {
      setError("Fill in your business name and contact details.");
      return;
    }

    setSubmitting(true);

    const clientId = newLocalId();
    const stallFeeCents = event.vendorStallFeeCents;
    const feeStatus: LocalVendor["feeStatus"] = stallFeeCents > 0 ? "PAID" : "NONE";

    const vendor: LocalVendor = {
      id: clientId,
      clientId,
      eventId: event.id,
      eventClientId: event.clientId,
      name: name.trim(),
      category,
      description: description.trim(),
      contactEmail: contactEmail.trim(),
      contactPhone: contactPhone.trim(),
      status: "PENDING",
      boothNumber: null,
      stallFeeCents,
      currency: event.currency,
      feeStatus,
      ownerUserId: user.id,
      badgeCode: null,
      checkedIn: false,
      checkedInAt: null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      syncStatus: "pending",
    };

    await db.vendors.put(vendor);

    await queueOp("APPLY_VENDOR", {
      clientId,
      eventId: event.id,
      eventClientId: event.clientId,
      name: vendor.name,
      category: vendor.category,
      description: vendor.description,
      contactEmail: vendor.contactEmail,
      contactPhone: vendor.contactPhone,
    });

    setSubmitting(false);
    setSubmitted(true);
  }

  return (
    <div className="mx-auto max-w-lg px-4 pb-20 pt-8 sm:px-6">
      <Link href={`/events/${slug}`} className="text-sm text-muted hover:text-foreground">
        ← {event.title}
      </Link>
      <h1 className="mb-1 mt-3 text-2xl font-bold">Apply as a vendor</h1>
      <p className="mb-6 text-sm text-muted">
        {event.title} · {event.venue}
      </p>

      <form onSubmit={onSubmit} className="card space-y-5 p-6">
        <div>
          <label className="label" htmlFor="name">Business / stall name</label>
          <input id="name" className="input" value={name} onChange={(e) => setName(e.target.value)} required />
        </div>

        <div>
          <label className="label" htmlFor="category">Category</label>
          <select id="category" className="input" value={category} onChange={(e) => setCategory(e.target.value)}>
            {VENDOR_CATEGORIES.map((c) => (
              <option key={c} value={c}>{c}</option>
            ))}
          </select>
        </div>

        <div>
          <label className="label" htmlFor="description">What are you offering?</label>
          <textarea
            id="description"
            className="input min-h-20"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
          />
        </div>

        <div className="grid grid-cols-2 gap-4">
          <div>
            <label className="label" htmlFor="contactEmail">Contact email</label>
            <input
              id="contactEmail"
              type="email"
              className="input"
              value={contactEmail}
              onChange={(e) => setContactEmail(e.target.value)}
              required
            />
          </div>
          <div>
            <label className="label" htmlFor="contactPhone">Contact phone</label>
            <input
              id="contactPhone"
              className="input"
              value={contactPhone}
              onChange={(e) => setContactPhone(e.target.value)}
              required
            />
          </div>
        </div>

        {event.vendorStallFeeCents > 0 && (
          <div className="rounded-lg border border-border bg-surface2 p-3 text-xs text-muted">
            Stall fee: {formatCents(event.vendorStallFeeCents, event.currency)}. Test checkout — no
            real payment is processed. Applications complete instantly, even offline, and sync
            automatically when connected.
          </div>
        )}

        {!user && (
          <p className="text-xs text-warn">You&apos;ll need to log in to submit this application.</p>
        )}

        {error && <p className="text-sm text-danger">{error}</p>}

        <button type="submit" disabled={submitting} className="btn-primary w-full">
          {submitting ? "Submitting…" : user ? "Submit application" : "Log in to apply"}
        </button>
      </form>
    </div>
  );
}
