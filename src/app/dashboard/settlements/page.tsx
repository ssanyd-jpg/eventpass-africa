"use client";

import { useEffect, useState } from "react";
import { useLiveQuery } from "dexie-react-hooks";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { db, newLocalId } from "@/lib/db";
import { queueOp, useOnlineStatus, pullFromServer } from "@/lib/sync-engine";
import { useAppSession } from "@/lib/use-app-session";
import { formatCents, formatDate } from "@/lib/format";

const PROVIDERS = [
  { value: "MPESA_TZ", label: "M-Pesa (Tanzania)" },
  { value: "TIGO_PESA", label: "Tigo Pesa / Mixx by Yas" },
  { value: "AIRTEL_MONEY", label: "Airtel Money" },
  { value: "HALOPESA", label: "HaloPesa" },
];

export default function SettlementsPage() {
  const { user, status } = useAppSession();
  const router = useRouter();
  const online = useOnlineStatus();

  const [provider, setProvider] = useState(PROVIDERS[0].value);
  const [phone, setPhone] = useState("");
  const [accountName, setAccountName] = useState("");
  const [running, setRunning] = useState(false);
  const [runMessage, setRunMessage] = useState<string | null>(null);

  const accounts = useLiveQuery(async () => {
    if (!user) return [];
    return db.mobileMoneyAccounts.where("organizationId").equals(user.organizationId).toArray();
  }, [user?.organizationId]);

  const settlements = useLiveQuery(async () => {
    if (!user) return [];
    const all = await db.settlements.where("organizationId").equals(user.organizationId).toArray();
    return all.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
  }, [user?.organizationId]);

  // An organization can run events in more than one currency — grouped here
  // (via each order's own `currency`, snapshotted at sale time) rather than
  // summed into one meaningless total.
  const estimatedUnsettledByCurrency = useLiveQuery(async () => {
    if (!user) return {} as Record<string, number>;
    const events = await db.events.where("organizationId").equals(user.organizationId).toArray();
    const eventIds = new Set(events.map((e) => e.id));
    const orders = await db.orders.toArray();
    const grossByCurrency: Record<string, number> = {};
    for (const o of orders) {
      if (eventIds.has(o.eventId) && o.syncStatus === "synced") {
        grossByCurrency[o.currency] = (grossByCurrency[o.currency] ?? 0) + o.totalCents;
      }
    }
    const mySettlements = await db.settlements.where("organizationId").equals(user.organizationId).toArray();
    for (const s of mySettlements) {
      grossByCurrency[s.currency] = Math.max(0, (grossByCurrency[s.currency] ?? 0) - s.grossCents);
    }
    return grossByCurrency;
  }, [user?.id, settlements]);

  useEffect(() => {
    if (status !== "loading" && !user) router.push("/login?callbackUrl=/dashboard/settlements");
  }, [status, user, router]);

  const hasAccount = (accounts?.length ?? 0) > 0;

  async function addAccount(e: React.FormEvent) {
    e.preventDefault();
    if (!user || !phone.trim() || !accountName.trim()) return;
    const clientId = newLocalId();
    await db.mobileMoneyAccounts.put({
      id: clientId,
      clientId,
      provider,
      phoneNumber: phone.trim(),
      accountName: accountName.trim(),
      isDefault: true,
      organizationId: user.organizationId,
      syncStatus: "pending",
    });
    await queueOp("ADD_MOBILE_MONEY_ACCOUNT", {
      clientId,
      provider,
      phoneNumber: phone.trim(),
      accountName: accountName.trim(),
    });
    setPhone("");
    setAccountName("");
  }

  async function runSettlement() {
    setRunning(true);
    setRunMessage(null);
    try {
      const res = await fetch("/api/settlements/run", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mobileMoneyAccountId: accounts?.[0]?.id }),
      });
      const data = await res.json();
      if (!res.ok || !data.ok) {
        setRunMessage(
          data.reason === "NOTHING_TO_SETTLE"
            ? "Nothing to settle right now — all synced sales are already paid out."
            : "Couldn't run settlement."
        );
      } else {
        const summary = data.settlements
          .map((s: { netCents: number; currency: string; payoutReference: string }) => `${formatCents(s.netCents, s.currency)} (Ref ${s.payoutReference})`)
          .join(", ");
        setRunMessage(`Paid out ${summary} for ${data.ordersSettled} order(s).`);
        await pullFromServer();
      }
    } catch {
      setRunMessage("Couldn't reach the server.");
    }
    setRunning(false);
  }

  if (!user) return null;

  const unsettledEntries = Object.entries(estimatedUnsettledByCurrency ?? {}).filter(([, cents]) => cents > 0);

  return (
    <div className="mx-auto max-w-3xl px-4 pb-20 pt-8 sm:px-6">
      <Link href="/dashboard" className="text-sm text-muted hover:text-foreground">← Dashboard</Link>
      <h1 className="mt-3 mb-1 text-2xl font-bold">Settlements</h1>
      <p className="mb-6 text-sm text-muted">
        Simulated same-day mobile money payouts. No real funds move — this
        models the payout ledger and integration point for a live provider.
      </p>

      {!hasAccount ? (
        <form onSubmit={addAccount} className="card space-y-4 p-6">
          <h2 className="font-semibold">Link a mobile money account</h2>
          <div>
            <label className="label" htmlFor="provider">Provider</label>
            <select id="provider" className="input" value={provider} onChange={(e) => setProvider(e.target.value)}>
              {PROVIDERS.map((p) => (
                <option key={p.value} value={p.value}>{p.label}</option>
              ))}
            </select>
          </div>
          <div>
            <label className="label" htmlFor="phone">Phone number</label>
            <input id="phone" className="input" placeholder="+255 7XX XXX XXX" value={phone} onChange={(e) => setPhone(e.target.value)} required />
          </div>
          <div>
            <label className="label" htmlFor="accountName">Account name</label>
            <input id="accountName" className="input" value={accountName} onChange={(e) => setAccountName(e.target.value)} required />
          </div>
          <button type="submit" className="btn-primary w-full">Save account</button>
        </form>
      ) : (
        <div className="card p-5">
          <div className="flex items-center justify-between">
            <div>
              <p className="font-semibold">{accounts![0].accountName}</p>
              <p className="text-sm text-muted">
                {PROVIDERS.find((p) => p.value === accounts![0].provider)?.label} · {accounts![0].phoneNumber}
              </p>
            </div>
            {accounts![0].syncStatus === "pending" && (
              <span className="pill border-warn/40 bg-warn/10 text-warn">Pending sync</span>
            )}
          </div>
        </div>
      )}

      <div className="card mt-6 flex flex-wrap items-center justify-between gap-4 p-6">
        <div>
          <p className="text-xs uppercase tracking-wide text-muted">Estimated unsettled</p>
          {unsettledEntries.length === 0 ? (
            <p className="text-2xl font-bold">{formatCents(0)}</p>
          ) : (
            unsettledEntries.map(([currency, cents]) => (
              <p key={currency} className="text-2xl font-bold">{formatCents(cents, currency)}</p>
            ))
          )}
          <p className="mt-1 text-xs text-muted">Based on sales already synced to the cloud.</p>
        </div>
        <button
          className="btn-primary"
          disabled={!online || !hasAccount || running}
          onClick={runSettlement}
        >
          {running ? "Running…" : "Run settlement now"}
        </button>
      </div>
      {!online && (
        <p className="mt-2 text-xs text-warn">Settlement payouts require a connection.</p>
      )}
      {runMessage && <p className="mt-2 text-sm">{runMessage}</p>}

      <h2 className="mb-3 mt-8 font-semibold">Payout history</h2>
      {settlements === undefined || settlements.length === 0 ? (
        <div className="card p-8 text-center text-muted">No settlements yet.</div>
      ) : (
        <div className="card divide-y divide-border">
          {settlements.map((s) => (
            <div key={s.id} className="flex flex-wrap items-center justify-between gap-2 p-4 text-sm">
              <div>
                <p className="font-semibold">{formatCents(s.netCents, s.currency)} net</p>
                <p className="text-xs text-muted">
                  {formatDate(s.createdAt)} · gross {formatCents(s.grossCents, s.currency)} · fee {formatCents(s.platformFeeCents, s.currency)}
                </p>
                {s.payoutReference && <p className="font-mono text-xs text-muted">{s.payoutReference}</p>}
              </div>
              <span className="pill border-ok/40 bg-ok/10 text-ok">{s.status}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
