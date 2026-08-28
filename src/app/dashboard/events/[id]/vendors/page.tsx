"use client";

import { useEffect, useState } from "react";
import { useLiveQuery } from "dexie-react-hooks";
import { useParams, useRouter } from "next/navigation";
import Link from "next/link";
import { db, newLocalId, type LocalVendor } from "@/lib/db";
import { queueOp } from "@/lib/sync-engine";
import { useAppSession } from "@/lib/use-app-session";
import { generateTicketCode, formatCents } from "@/lib/format";
import { replaceVendorBadgeCode } from "./actions";

const VENDOR_CATEGORIES = ["Food", "Merchandise", "Services", "Other"];

export default function ManageVendorsPage() {
  const { id: rawId } = useParams<{ id: string }>();
  const id = decodeURIComponent(rawId);
  const router = useRouter();
  const { user } = useAppSession();

  // Middleware already redirects GATE_CREW away from this route server-side
  // — this is defense-in-depth for a device offline with an already-cached
  // page shell (see src/middleware.ts).
  useEffect(() => {
    if (user?.organizationRole === "GATE_CREW") router.replace("/dashboard");
  }, [user, router]);

  const event = useLiveQuery(async () => {
    const byId = await db.events.get(id);
    return byId ?? (await db.events.where("clientId").equals(id).first()) ?? null;
  }, [id]);

  const vendors = useLiveQuery(async () => {
    if (!event) return [];
    const all = await db.vendors.where("eventId").equals(event.id).toArray();
    return all.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
  }, [event?.id]);

  const [busyId, setBusyId] = useState<string | null>(null);
  const [showAddForm, setShowAddForm] = useState(false);
  const [addName, setAddName] = useState("");
  const [addCategory, setAddCategory] = useState(VENDOR_CATEGORIES[0]);
  const [addBooth, setAddBooth] = useState("");
  const [adding, setAdding] = useState(false);

  if (user?.organizationRole === "GATE_CREW") return null;

  if (event === undefined) {
    return <div className="mx-auto max-w-3xl px-4 py-16 text-center text-muted">Loading…</div>;
  }

  if (!event) {
    return (
      <div className="mx-auto max-w-3xl px-4 py-16 text-center">
        <p className="font-semibold">Event not found on this device.</p>
        <Link href="/dashboard" className="btn-secondary mt-6 inline-flex">Back to dashboard</Link>
      </div>
    );
  }

  async function approveVendor(vendor: LocalVendor) {
    const boothNumber = window.prompt("Booth number (optional):", vendor.boothNumber ?? "") ?? vendor.boothNumber;
    const badgeCode = vendor.badgeCode ?? generateTicketCode();
    setBusyId(vendor.id);
    try {
      await db.vendors.put({
        ...vendor,
        status: "APPROVED",
        boothNumber: boothNumber || null,
        badgeCode,
        syncStatus: "pending",
      });
      await queueOp("APPROVE_VENDOR", {
        vendorId: vendor.id,
        vendorClientId: vendor.clientId,
        boothNumber: boothNumber || undefined,
        badgeCode,
      });
    } finally {
      setBusyId(null);
    }
  }

  // Only meaningful for a vendor whose id is already the real server id
  // (syncStatus "synced") — a still-pending offline-created vendor has no
  // server row yet to regenerate a badge for.
  async function regenerateBadge(vendor: LocalVendor) {
    if (!confirm(`Mark ${vendor.name}'s badge as lost and issue a new code?`)) return;
    setBusyId(vendor.id);
    try {
      const updated = await replaceVendorBadgeCode(vendor.id);
      await db.vendors.put({ ...vendor, badgeCode: updated.badgeCode, updatedAt: updated.updatedAt.toISOString(), syncStatus: "synced" });
    } catch {
      alert("Couldn't replace the badge code. Try again.");
    } finally {
      setBusyId(null);
    }
  }

  async function rejectVendor(vendor: LocalVendor) {
    if (!confirm(`Reject ${vendor.name}'s application?`)) return;
    setBusyId(vendor.id);
    try {
      await db.vendors.put({
        ...vendor,
        status: "REJECTED",
        feeStatus: vendor.feeStatus === "PAID" ? "REFUNDED" : vendor.feeStatus,
        syncStatus: "pending",
      });
      await queueOp("REJECT_VENDOR", { vendorId: vendor.id, vendorClientId: vendor.clientId });
    } finally {
      setBusyId(null);
    }
  }

  async function addVendor(e: React.FormEvent) {
    e.preventDefault();
    if (!addName.trim() || !event) return;
    setAdding(true);

    const clientId = newLocalId();
    const badgeCode = generateTicketCode();
    const vendor: LocalVendor = {
      id: clientId,
      clientId,
      eventId: event.id,
      eventClientId: event.clientId,
      name: addName.trim(),
      category: addCategory,
      description: "",
      contactEmail: "",
      contactPhone: "",
      status: "APPROVED",
      boothNumber: addBooth.trim() || null,
      stallFeeCents: 0,
      currency: event.currency,
      feeStatus: "NONE",
      ownerUserId: null,
      badgeCode,
      checkedIn: false,
      checkedInAt: null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      syncStatus: "pending",
    };

    await db.vendors.put(vendor);
    await queueOp("ADD_VENDOR", {
      clientId,
      eventId: event.id,
      eventClientId: event.clientId,
      name: vendor.name,
      category: vendor.category,
      boothNumber: vendor.boothNumber ?? undefined,
      badgeCode,
      feeStatus: "NONE",
    });

    setAddName("");
    setAddBooth("");
    setShowAddForm(false);
    setAdding(false);
  }

  const pending = (vendors ?? []).filter((v) => v.status === "PENDING");
  const approved = (vendors ?? []).filter((v) => v.status === "APPROVED");
  const rejected = (vendors ?? []).filter((v) => v.status === "REJECTED");

  return (
    <div className="mx-auto max-w-3xl px-4 pb-20 pt-8 sm:px-6">
      <Link href={`/dashboard/events/${event.id}`} className="text-sm text-muted hover:text-foreground">
        ← {event.title}
      </Link>
      <div className="mt-3 flex items-center justify-between">
        <h1 className="text-2xl font-bold">Vendors</h1>
        <button className="btn-secondary" onClick={() => setShowAddForm((v) => !v)}>
          + Add vendor
        </button>
      </div>

      {showAddForm && (
        <form onSubmit={addVendor} className="card mt-4 space-y-3 p-4">
          <div className="grid grid-cols-[1fr_140px] gap-3">
            <div>
              <label className="label" htmlFor="addName">Name</label>
              <input id="addName" className="input" value={addName} onChange={(e) => setAddName(e.target.value)} required />
            </div>
            <div>
              <label className="label" htmlFor="addCategory">Category</label>
              <select id="addCategory" className="input" value={addCategory} onChange={(e) => setAddCategory(e.target.value)}>
                {VENDOR_CATEGORIES.map((c) => (
                  <option key={c} value={c}>{c}</option>
                ))}
              </select>
            </div>
          </div>
          <div>
            <label className="label" htmlFor="addBooth">Booth number (optional)</label>
            <input id="addBooth" className="input" value={addBooth} onChange={(e) => setAddBooth(e.target.value)} />
          </div>
          <button type="submit" disabled={adding} className="btn-primary w-full">
            {adding ? "Adding…" : "Add & approve"}
          </button>
        </form>
      )}

      <h2 className="mb-3 mt-8 font-semibold">Pending ({pending.length})</h2>
      {pending.length === 0 ? (
        <p className="text-sm text-muted">No applications waiting on review.</p>
      ) : (
        <div className="card divide-y divide-border">
          {pending.map((v) => (
            <div key={v.id} className="flex flex-wrap items-center justify-between gap-3 p-4">
              <div>
                <p className="font-medium">{v.name}</p>
                <p className="text-sm text-muted">
                  {v.category} · {v.contactEmail} · {v.contactPhone}
                  {v.stallFeeCents > 0 && ` · ${formatCents(v.stallFeeCents, v.currency)} (${v.feeStatus === "PAID" ? "paid" : v.feeStatus})`}
                </p>
              </div>
              <div className="flex gap-2">
                <button
                  className="text-xs font-medium text-danger hover:underline disabled:opacity-50"
                  disabled={busyId === v.id}
                  onClick={() => rejectVendor(v)}
                >
                  Reject
                </button>
                <button
                  className="btn-primary !px-3 !py-1.5 text-xs disabled:opacity-50"
                  disabled={busyId === v.id}
                  onClick={() => approveVendor(v)}
                >
                  {busyId === v.id ? "…" : "Approve"}
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      <h2 className="mb-3 mt-8 font-semibold">Approved ({approved.length})</h2>
      {approved.length === 0 ? (
        <p className="text-sm text-muted">No approved vendors yet.</p>
      ) : (
        <div className="card divide-y divide-border">
          {approved.map((v) => (
            <div key={v.id} className="flex flex-wrap items-center justify-between gap-3 p-4">
              <div>
                <p className="font-medium">{v.name}</p>
                <p className="text-sm text-muted">
                  {v.category}{v.boothNumber ? ` · Booth ${v.boothNumber}` : ""} · badge {v.badgeCode}
                </p>
              </div>
              <div className="flex items-center gap-3">
                <span className={`pill ${v.checkedIn ? "border-ok/40 bg-ok/10 text-ok" : "border-border text-muted"}`}>
                  {v.checkedIn ? "Checked in" : "Not checked in"}
                </span>
                {v.syncStatus === "synced" && (
                  <button
                    className="text-xs font-medium text-danger hover:underline disabled:opacity-50"
                    disabled={busyId === v.id}
                    onClick={() => regenerateBadge(v)}
                  >
                    Mark lost & issue new code
                  </button>
                )}
              </div>
            </div>
          ))}
        </div>
      )}

      {rejected.length > 0 && (
        <>
          <h2 className="mb-3 mt-8 font-semibold">Rejected ({rejected.length})</h2>
          <div className="card divide-y divide-border">
            {rejected.map((v) => (
              <div key={v.id} className="p-4 text-sm text-muted">
                {v.name} · {v.category}
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
