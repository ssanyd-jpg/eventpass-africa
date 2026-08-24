"use client";

import { useEffect } from "react";
import { useLiveQuery } from "dexie-react-hooks";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { db } from "@/lib/db";
import { useAppSession } from "@/lib/use-app-session";
import { formatCents } from "@/lib/format";
import TicketQr from "@/components/TicketQr";

const STATUS_STYLE: Record<string, string> = {
  PENDING: "border-warn/40 bg-warn/10 text-warn",
  APPROVED: "border-ok/40 bg-ok/10 text-ok",
  REJECTED: "border-danger/40 bg-danger/10 text-danger",
};

const STATUS_LABEL: Record<string, string> = {
  PENDING: "Pending review",
  APPROVED: "Approved",
  REJECTED: "Rejected",
};

export default function VendorApplicationsPage() {
  const { user, status } = useAppSession();
  const router = useRouter();

  const vendors = useLiveQuery(async () => {
    if (!user) return [];
    const all = await db.vendors.where("ownerUserId").equals(user.id).toArray();
    return all.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
  }, [user?.id]);

  useEffect(() => {
    if (status !== "loading" && !user) router.push("/login?callbackUrl=/account/vendor-applications");
  }, [status, user, router]);

  if (!user) return null;

  return (
    <div className="mx-auto max-w-3xl px-4 pb-20 pt-8 sm:px-6">
      <h1 className="mb-6 text-2xl font-bold">My Vendor Applications</h1>

      {vendors === undefined ? (
        <div className="space-y-3">
          {Array.from({ length: 2 }).map((_, i) => (
            <div key={i} className="card h-24 animate-pulse bg-surface2" />
          ))}
        </div>
      ) : vendors.length === 0 ? (
        <div className="card p-10 text-center text-muted">
          No vendor applications yet. <Link href="/" className="text-accent-hover">Find an event</Link>
        </div>
      ) : (
        <div className="space-y-3">
          {vendors.map((v) => (
            <div key={v.id} className="card p-4">
              <div className="flex items-start justify-between gap-3">
                <div>
                  <p className="font-semibold">{v.name}</p>
                  <p className="text-sm text-muted">
                    {v.category}
                    {v.boothNumber ? ` · Booth ${v.boothNumber}` : ""}
                    {v.stallFeeCents > 0 ? ` · ${formatCents(v.stallFeeCents, v.currency)} fee` : ""}
                  </p>
                  {v.feeStatus === "PAID" && <p className="mt-1 text-xs text-ok">Fee paid</p>}
                  {v.feeStatus === "REFUNDED" && <p className="mt-1 text-xs text-muted">Fee refunded</p>}
                </div>
                <span className={`pill ${STATUS_STYLE[v.status]}`}>{STATUS_LABEL[v.status]}</span>
              </div>

              {v.status === "APPROVED" && v.badgeCode && (
                <div className="mt-4 flex flex-col items-center gap-2 border-t border-border pt-4">
                  <TicketQr code={v.badgeCode} />
                  <p className="font-mono text-sm">{v.badgeCode}</p>
                  <p className="text-xs text-muted">Show this at the gate for vendor entry.</p>
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
