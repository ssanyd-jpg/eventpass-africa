"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { provisionWristbandAction } from "../actions";

// Minimal stand-in for a full gate-side provisioning flow — see
// provisionSeasonPassWristband's own comment in src/lib/season-pass.ts.
// The organiser types (or scans, with any NFC reader that emits its uid as
// text into this input) the wristband's uid here, once, after which the
// gate scanner recognises it for every event linked to this pass.
export default function WristbandProvision({ holderId, provisioned }: { holderId: string; provisioned: boolean }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [nfcUid, setNfcUid] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (provisioned) {
    return <span className="pill border-ok/40 bg-ok/10 text-ok">Wristband provisioned</span>;
  }

  if (!open) {
    return (
      <button className="btn-secondary !px-3 !py-1.5 text-xs" onClick={() => setOpen(true)}>
        Provision wristband
      </button>
    );
  }

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const result = await provisionWristbandAction(holderId, nfcUid);
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setOpen(false);
      router.refresh();
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={onSubmit} className="flex items-center gap-2">
      <input
        className="input !h-8 !w-40 !py-1 text-xs"
        placeholder="Wristband NFC uid"
        value={nfcUid}
        onChange={(e) => setNfcUid(e.target.value)}
        autoFocus
      />
      <button type="submit" className="btn-primary !px-3 !py-1.5 text-xs" disabled={busy || !nfcUid.trim()}>
        Save
      </button>
      {error && <span className="text-xs text-danger">{error}</span>}
    </form>
  );
}
