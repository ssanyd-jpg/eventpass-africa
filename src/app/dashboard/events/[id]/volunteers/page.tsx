"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import Link from "next/link";
import { useAppSession } from "@/lib/use-app-session";
import { formatDateTime } from "@/lib/format";
import {
  addVolunteerAction,
  importVolunteersAction,
  sendVolunteerInviteAction,
  setVolunteerStatusAction,
  type AddVolunteerInput,
} from "./actions";
import { SkeletonPage } from "@/components/Skeleton";

interface VolunteerRow {
  id: string;
  name: string;
  phone: string;
  email: string | null;
  role: string;
  shiftStart: string;
  shiftEnd: string;
  zoneAccess: string;
  status: "INVITED" | "CONFIRMED" | "CHECKED_IN" | "NO_SHOW";
  notes: string | null;
}

const STATUS_PILL: Record<VolunteerRow["status"], string> = {
  INVITED: "pill border-border text-muted",
  CONFIRMED: "pill border-accent/40 bg-accent-soft text-accent-hover",
  CHECKED_IN: "pill border-ok/40 bg-ok/10 text-ok",
  NO_SHOW: "pill border-danger/40 bg-danger/10 text-danger",
};

const EMPTY_FORM = { name: "", phone: "", email: "", role: "", shiftStart: "", shiftEnd: "", zoneAccess: "", notes: "" };

export default function VolunteersPage() {
  const { id: rawId } = useParams<{ id: string }>();
  const eventId = decodeURIComponent(rawId);
  const router = useRouter();
  const { user } = useAppSession();

  useEffect(() => {
    if (user?.organizationRole === "GATE_CREW") router.replace("/dashboard");
  }, [user, router]);

  const [eventTitle, setEventTitle] = useState<string | null>(null);
  const [volunteers, setVolunteers] = useState<VolunteerRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [form, setForm] = useState(EMPTY_FORM);
  const [saving, setSaving] = useState(false);
  const [importing, setImporting] = useState(false);
  const [importErrors, setImportErrors] = useState<string[]>([]);
  const [busyId, setBusyId] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch(`/api/dashboard/events/${eventId}/volunteers`, { cache: "no-store" });
      const body = await res.json();
      if (!res.ok || !body.ok) {
        setError(body.reason ?? "Failed to load");
        return;
      }
      setEventTitle(body.eventTitle);
      setVolunteers(body.volunteers);
    } catch {
      setError("Failed to load");
    }
  }, [eventId]);

  useEffect(() => {
    load();
  }, [load]);

  async function onAddVolunteer(e: React.FormEvent) {
    e.preventDefault();
    if (!form.name.trim() || !form.phone.trim() || !form.role.trim() || !form.shiftStart || !form.shiftEnd) return;
    setSaving(true);
    setError(null);
    try {
      const input: AddVolunteerInput = {
        name: form.name.trim(),
        phone: form.phone.trim(),
        email: form.email.trim() || undefined,
        role: form.role.trim(),
        shiftStart: new Date(form.shiftStart).toISOString(),
        shiftEnd: new Date(form.shiftEnd).toISOString(),
        zoneAccess: form.zoneAccess.split(",").map((z) => z.trim()).filter(Boolean),
        notes: form.notes.trim() || undefined,
      };
      await addVolunteerAction(eventId, input);
      setForm(EMPTY_FORM);
      setNotice(`Added ${input.name}.`);
      await load();
    } catch {
      setError("Couldn't add that volunteer.");
    } finally {
      setSaving(false);
    }
  }

  async function onImportFile(file: File) {
    setImporting(true);
    setImportErrors([]);
    setError(null);
    try {
      const text = await file.text();
      const result = await importVolunteersAction(eventId, text);
      setImportErrors(result.errors);
      setNotice(`Imported ${result.created} volunteer(s)${result.errors.length > 0 ? ` — ${result.errors.length} row(s) skipped` : ""}.`);
      await load();
    } catch {
      setError("Couldn't import that file.");
    } finally {
      setImporting(false);
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
  }

  async function onInvite(volunteerId: string) {
    setBusyId(volunteerId);
    try {
      await sendVolunteerInviteAction(eventId, volunteerId);
      setNotice("Invitation sent.");
      await load();
    } catch {
      setError("Couldn't send the invitation.");
    } finally {
      setBusyId(null);
    }
  }

  async function onSetStatus(volunteerId: string, status: VolunteerRow["status"]) {
    setBusyId(volunteerId);
    try {
      await setVolunteerStatusAction(eventId, volunteerId, status);
      await load();
    } catch {
      setError("Couldn't update that volunteer.");
    } finally {
      setBusyId(null);
    }
  }

  if (user?.organizationRole === "GATE_CREW") return null;

  if (error && !volunteers) {
    return (
      <div className="mx-auto max-w-4xl px-4 py-16 text-center">
        <p className="text-lg font-semibold">Couldn&apos;t load this event&apos;s volunteers.</p>
        <Link href={`/dashboard/events/${eventId}`} className="btn-secondary mt-6 inline-flex">← Back to event</Link>
      </div>
    );
  }

  if (!volunteers) {
    return <SkeletonPage maxWidth="max-w-4xl" />;
  }

  return (
    <div className="mx-auto max-w-4xl px-4 pb-20 pt-8 sm:px-6">
      <Link href={`/dashboard/events/${eventId}`} className="text-sm text-muted hover:text-foreground">
        ← {eventTitle}
      </Link>
      <div className="mt-3 flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-2xl font-bold">Volunteers</h1>
        <a href={`/api/dashboard/events/${eventId}/volunteers/export`} className="btn-secondary">
          Export CSV
        </a>
      </div>
      <p className="mb-6 text-sm text-muted">
        Assign roles, shifts, and zone access, then send WhatsApp invitations. Check people in at the wristband desk.
      </p>

      {notice && (
        <div className="mb-4 rounded-lg border border-accent/40 bg-accent-soft px-3 py-2 text-sm text-accent-hover">
          {notice}
        </div>
      )}
      {error && (
        <div className="mb-4 rounded-lg border border-danger/40 bg-danger/10 px-3 py-2 text-sm text-danger">
          {error}
        </div>
      )}

      <div className="card mb-6 p-5">
        <p className="mb-3 font-medium">Bulk import from CSV</p>
        <p className="mb-3 text-sm text-muted">
          Header row required, with columns <code>name, phone, role, shiftStart, shiftEnd</code> (dates as ISO
          timestamps). Optional columns: <code>email, zoneAccess, notes</code>.
        </p>
        <input
          ref={fileInputRef}
          type="file"
          accept=".csv,text/csv"
          disabled={importing}
          onChange={(e) => {
            const file = e.target.files?.[0];
            if (file) onImportFile(file);
          }}
        />
        {importErrors.length > 0 && (
          <ul className="mt-3 list-inside list-disc text-sm text-danger">
            {importErrors.map((e, i) => (
              <li key={i}>{e}</li>
            ))}
          </ul>
        )}
      </div>

      <form onSubmit={onAddVolunteer} className="card mb-6 space-y-3 p-5">
        <p className="font-medium">Add a volunteer</p>
        <div className="grid gap-3 sm:grid-cols-2">
          <div>
            <label className="label" htmlFor="v-name">Name</label>
            <input id="v-name" className="input" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} required />
          </div>
          <div>
            <label className="label" htmlFor="v-phone">Phone</label>
            <input id="v-phone" className="input" value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} required />
          </div>
          <div>
            <label className="label" htmlFor="v-email">Email (optional)</label>
            <input id="v-email" type="email" className="input" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} />
          </div>
          <div>
            <label className="label" htmlFor="v-role">Role</label>
            <input id="v-role" className="input" placeholder="Gate crew, Water station, Medical…" value={form.role} onChange={(e) => setForm({ ...form, role: e.target.value })} required />
          </div>
          <div>
            <label className="label" htmlFor="v-start">Shift start</label>
            <input id="v-start" type="datetime-local" className="input" value={form.shiftStart} onChange={(e) => setForm({ ...form, shiftStart: e.target.value })} required />
          </div>
          <div>
            <label className="label" htmlFor="v-end">Shift end</label>
            <input id="v-end" type="datetime-local" className="input" value={form.shiftEnd} onChange={(e) => setForm({ ...form, shiftEnd: e.target.value })} required />
          </div>
          <div className="sm:col-span-2">
            <label className="label" htmlFor="v-zones">Zone access (comma-separated)</label>
            <input id="v-zones" className="input" placeholder="General Admission, Pitch-side" value={form.zoneAccess} onChange={(e) => setForm({ ...form, zoneAccess: e.target.value })} />
          </div>
          <div className="sm:col-span-2">
            <label className="label" htmlFor="v-notes">Notes (optional)</label>
            <input id="v-notes" className="input" value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} />
          </div>
        </div>
        <button type="submit" className="btn-primary" disabled={saving}>
          {saving ? "Adding…" : "Add volunteer"}
        </button>
      </form>

      <div className="card divide-y divide-border p-0">
        {volunteers.length === 0 ? (
          <p className="p-5 text-sm text-muted">No volunteers added yet.</p>
        ) : (
          volunteers.map((v) => (
            <div key={v.id} className="flex flex-wrap items-center justify-between gap-3 p-5">
              <div>
                <p className="font-medium">
                  {v.name} <span className={STATUS_PILL[v.status]}>{v.status.replace("_", " ")}</span>
                </p>
                <p className="text-sm text-muted">
                  {v.role} · {formatDateTime(v.shiftStart)} – {new Date(v.shiftEnd).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" })}
                </p>
                <p className="text-xs text-muted">
                  {v.phone}
                  {v.zoneAccess ? ` · Zones: ${v.zoneAccess}` : ""}
                </p>
              </div>
              <div className="flex flex-wrap gap-2">
                <button className="btn-secondary" disabled={busyId === v.id} onClick={() => onInvite(v.id)}>
                  {busyId === v.id ? "…" : "Send invite"}
                </button>
                {v.status !== "CONFIRMED" && v.status !== "CHECKED_IN" && (
                  <button className="btn-secondary" disabled={busyId === v.id} onClick={() => onSetStatus(v.id, "CONFIRMED")}>
                    Mark confirmed
                  </button>
                )}
                {v.status !== "NO_SHOW" && v.status !== "CHECKED_IN" && (
                  <button className="btn-secondary" disabled={busyId === v.id} onClick={() => onSetStatus(v.id, "NO_SHOW")}>
                    Mark no-show
                  </button>
                )}
              </div>
            </div>
          ))
        )}
      </div>
    </div>
  );
}
