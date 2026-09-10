"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import Link from "next/link";
import { useAppSession } from "@/lib/use-app-session";
import { formatCents } from "@/lib/format";
import {
  MINOR_VARIANCE_THRESHOLD_CENTS,
  computeVariance,
  classifyVariance,
  type FloatStatus,
} from "@/lib/reconciliation";
import { saveFloatDeclaration } from "./actions";

interface OperatorRow {
  operatorId: string;
  operatorName: string;
  cashTransactionCount: number;
  systemTotalCents: number;
  averageCents: number;
  declaration: { declaredAmountCents: number; varianceCents: number; status: string; declaredAt: string } | null;
}

interface ReconciliationPayload {
  eventId: string;
  eventTitle: string;
  summary: {
    currency: string;
    totalTicketRevenueCents: number;
    digitalTicketRevenueCents: number;
    cashTicketRevenueCents: number;
    unspentWalletBalanceCents: number;
    vendorSalesCents: number;
    netBreakageCents: number;
  };
  operators: OperatorRow[];
  unreconciledOperatorCount: number;
}

const STATUS_LABEL: Record<FloatStatus, string> = {
  BALANCED: "Balanced",
  MINOR_VARIANCE: "Minor variance",
  INVESTIGATE: "Investigate",
};
const STATUS_STYLE: Record<FloatStatus, string> = {
  BALANCED: "pill border-ok/40 bg-ok/10 text-ok",
  MINOR_VARIANCE: "pill border-warn/40 bg-warn/10 text-warn",
  INVESTIGATE: "pill border-danger/40 bg-danger/10 text-danger",
};
// Green at zero, amber under the threshold, red at/over it — the Session 9
// colour spec, driven off the same classifyVariance the server uses.
const VARIANCE_TEXT: Record<FloatStatus, string> = {
  BALANCED: "text-ok",
  MINOR_VARIANCE: "text-warn",
  INVESTIGATE: "text-danger",
};

export default function ReconciliationPage() {
  const { id: rawId } = useParams<{ id: string }>();
  const eventId = decodeURIComponent(rawId);
  const router = useRouter();
  const { user } = useAppSession();

  // Middleware already redirects GATE_CREW away from /dashboard/events/** —
  // this is the same defense-in-depth guard every sibling page carries.
  useEffect(() => {
    if (user?.organizationRole === "GATE_CREW") router.replace("/dashboard");
  }, [user, router]);

  const [data, setData] = useState<ReconciliationPayload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [savingId, setSavingId] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch(`/api/dashboard/events/${eventId}/reconciliation`, { cache: "no-store" });
      const body = await res.json();
      if (!body.ok) {
        setError(body.reason === "NOT_FOUND" ? "Event not found." : "Couldn't load the reconciliation report.");
        return;
      }
      setError(null);
      setData(body);
    } catch {
      setError((prev) => prev ?? "Couldn't load the reconciliation report.");
    }
  }, [eventId]);

  useEffect(() => {
    load();
  }, [load]);

  async function confirmDeclaration(op: OperatorRow) {
    const raw = drafts[op.operatorId];
    const major = parseFloat(raw ?? "");
    if (!Number.isFinite(major) || major < 0) {
      alert("Enter the physical cash amount handed in.");
      return;
    }
    setSavingId(op.operatorId);
    try {
      await saveFloatDeclaration({
        eventId,
        operatorId: op.operatorId,
        declaredAmountCents: Math.round(major * 100),
      });
      setDrafts((d) => {
        const next = { ...d };
        delete next[op.operatorId];
        return next;
      });
      await load();
    } catch {
      alert("Couldn't save that declaration. Try again.");
    } finally {
      setSavingId(null);
    }
  }

  if (user?.organizationRole === "GATE_CREW") return null;

  if (!data && error) {
    return (
      <div className="mx-auto max-w-3xl px-4 py-16 text-center">
        <p className="font-semibold">{error}</p>
        <Link href={`/dashboard/events/${eventId}`} className="btn-secondary mt-6 inline-flex">Back to event</Link>
      </div>
    );
  }
  if (!data) {
    return <div className="mx-auto max-w-3xl px-4 py-16 text-center text-muted">Loading…</div>;
  }

  const { summary } = data;
  const c = summary.currency;

  return (
    <div className="mx-auto max-w-5xl px-4 pb-20 pt-8 sm:px-6">
      <Link href={`/dashboard/events/${eventId}`} className="text-sm text-muted hover:text-foreground">
        ← {data.eventTitle}
      </Link>
      <div className="mt-3 flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-2xl font-bold">Cash float reconciliation</h1>
        <a
          href={`/api/dashboard/events/${eventId}/reconciliation/export`}
          className="btn-secondary"
        >
          Export CSV
        </a>
      </div>

      {data.unreconciledOperatorCount > 0 && (
        <p className="mt-4 rounded-xl border border-warn/40 bg-warn/10 p-4 text-sm">
          {data.unreconciledOperatorCount} cash{" "}
          {data.unreconciledOperatorCount === 1 ? "operator has" : "operators have"} not been reconciled yet.
        </p>
      )}

      <h2 className="mb-3 mt-8 font-semibold">Summary</h2>
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
        <SummaryCard label="Total ticket revenue" value={formatCents(summary.totalTicketRevenueCents, c)} />
        <SummaryCard label="Digital (AirPay)" value={formatCents(summary.digitalTicketRevenueCents, c)} />
        <SummaryCard label="Cash / in-person" value={formatCents(summary.cashTicketRevenueCents, c)} />
        <SummaryCard label="Unspent wallet balance" value={formatCents(summary.unspentWalletBalanceCents, c)} />
        <SummaryCard label="Vendor sales" value={formatCents(summary.vendorSalesCents, c)} />
        <SummaryCard
          label="Net breakage (unspent > 90 days)"
          value={formatCents(summary.netBreakageCents, c)}
          flag={summary.netBreakageCents > 0}
        />
      </div>

      <h2 className="mb-3 mt-10 font-semibold">Per-operator cash float</h2>
      {data.operators.length === 0 ? (
        <div className="card p-8 text-center text-muted">No cash (in-person) ticket sales recorded for this event.</div>
      ) : (
        <div className="card overflow-x-auto p-0">
          <table className="w-full text-left text-sm">
            <thead>
              <tr className="border-b border-border text-xs font-medium uppercase tracking-wide text-muted">
                <th className="p-3">Operator</th>
                <th className="p-3 text-right">Cash txns</th>
                <th className="p-3 text-right">System total</th>
                <th className="p-3 text-right">Avg</th>
                <th className="p-3">Declared float</th>
                <th className="p-3 text-right">Variance</th>
                <th className="p-3">Status</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {data.operators.map((op) => (
                <OperatorRowView
                  key={op.operatorId}
                  op={op}
                  currency={c}
                  draft={drafts[op.operatorId] ?? ""}
                  saving={savingId === op.operatorId}
                  onDraftChange={(v) => setDrafts((d) => ({ ...d, [op.operatorId]: v }))}
                  onConfirm={() => confirmDeclaration(op)}
                />
              ))}
            </tbody>
          </table>
        </div>
      )}
      <p className="mt-3 text-xs text-muted">
        Variance = system total − declared float. Green at zero, amber under{" "}
        {formatCents(MINOR_VARIANCE_THRESHOLD_CENTS, c)}, red at or over it.
      </p>
    </div>
  );
}

function SummaryCard({ label, value, flag }: { label: string; value: string; flag?: boolean }) {
  return (
    <div className={`card p-5 ${flag ? "border-warn/40 bg-warn/5" : ""}`}>
      <p className="text-xs uppercase tracking-wide text-muted">{label}</p>
      <p className="mt-1 text-xl font-bold tabular-nums">{value}</p>
    </div>
  );
}

function OperatorRowView({
  op,
  currency,
  draft,
  saving,
  onDraftChange,
  onConfirm,
}: {
  op: OperatorRow;
  currency: string;
  draft: string;
  saving: boolean;
  onDraftChange: (v: string) => void;
  onConfirm: () => void;
}) {
  // Live preview of the variance/status as the organiser types, before
  // they confirm; falls back to the persisted declaration otherwise.
  const preview = useMemo(() => {
    const major = parseFloat(draft);
    if (draft !== "" && Number.isFinite(major) && major >= 0) {
      const v = computeVariance(op.systemTotalCents, Math.round(major * 100));
      return { varianceCents: v, status: classifyVariance(v) };
    }
    if (op.declaration) {
      return { varianceCents: op.declaration.varianceCents, status: op.declaration.status as FloatStatus };
    }
    return null;
  }, [draft, op]);

  return (
    <tr>
      <td className="p-3">
        <span className="font-medium">{op.operatorName}</span>
        <span className="block font-mono text-[11px] text-muted">{op.operatorId}</span>
      </td>
      <td className="p-3 text-right tabular-nums">{op.cashTransactionCount}</td>
      <td className="p-3 text-right tabular-nums">{formatCents(op.systemTotalCents, currency)}</td>
      <td className="p-3 text-right tabular-nums">{formatCents(op.averageCents, currency)}</td>
      <td className="p-3">
        <div className="flex items-center gap-2">
          <input
            type="number"
            min="0"
            step="0.01"
            className="input !h-9 w-28"
            placeholder={op.declaration ? String(op.declaration.declaredAmountCents / 100) : "0"}
            value={draft}
            onChange={(e) => onDraftChange(e.target.value)}
          />
          <button
            className="btn-primary !px-3 !py-1.5 text-xs disabled:opacity-50"
            disabled={saving || draft === ""}
            onClick={onConfirm}
          >
            {saving ? "…" : op.declaration ? "Update" : "Confirm"}
          </button>
        </div>
      </td>
      <td className={`p-3 text-right tabular-nums ${preview ? VARIANCE_TEXT[preview.status] : ""}`}>
        {preview ? formatCents(preview.varianceCents, currency) : "—"}
      </td>
      <td className="p-3">
        {preview ? <span className={STATUS_STYLE[preview.status]}>{STATUS_LABEL[preview.status]}</span> : <span className="text-muted">Not declared</span>}
      </td>
    </tr>
  );
}
