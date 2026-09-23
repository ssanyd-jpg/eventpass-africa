"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

export default function RedeemButton({ rewardId, disabled, disabledReason }: { rewardId: string; disabled: boolean; disabledReason: string | null }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onRedeem() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/loyalty/rewards/${rewardId}/redeem`, { method: "POST" });
      const body = await res.json().catch(() => null);
      if (!res.ok || !body?.ok) {
        setError(body?.error ?? "Couldn't redeem this reward.");
        return;
      }
      router.refresh();
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-col items-end gap-1">
      <button className="btn-primary !px-3 !py-1.5 text-xs" disabled={busy || disabled} onClick={onRedeem}>
        {busy ? "Redeeming…" : "Redeem"}
      </button>
      {disabled && disabledReason && <p className="max-w-[14rem] text-right text-xs text-muted">{disabledReason}</p>}
      {error && <p className="max-w-[14rem] text-right text-xs text-danger">{error}</p>}
    </div>
  );
}
