"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { signOut } from "next-auth/react";
import { deleteAccount } from "./actions";

export default function DeleteAccountSection({ blockedReason }: { blockedReason: string | null }) {
  const router = useRouter();
  const [confirming, setConfirming] = useState(false);
  const [confirmText, setConfirmText] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  if (blockedReason) {
    return (
      <p className="rounded-lg border border-danger/30 bg-danger/5 p-3 text-sm text-danger">
        {blockedReason}
      </p>
    );
  }

  if (!confirming) {
    return (
      <button type="button" onClick={() => setConfirming(true)} className="btn-secondary text-sm !text-danger">
        Delete my account
      </button>
    );
  }

  function handleDelete() {
    setError(null);
    startTransition(async () => {
      try {
        await deleteAccount();
        // Clears the client-side session cookie immediately — the
        // UserSession row deleteAccount() just removed would otherwise take
        // up to 5 minutes to be noticed by auth.ts's periodic revocation
        // check (see SESSION_RECHECK_INTERVAL_MS).
        await signOut({ redirect: false });
        router.push("/");
      } catch (err) {
        setError(err instanceof Error ? err.message : "Something went wrong. Please try again.");
      }
    });
  }

  return (
    <div className="space-y-3">
      <p className="text-sm font-medium">
        This cannot be undone. Type <span className="font-mono">DELETE</span> to confirm.
      </p>
      <input
        value={confirmText}
        onChange={(e) => setConfirmText(e.target.value)}
        className="input w-full"
        placeholder="DELETE"
        autoComplete="off"
        disabled={isPending}
      />
      {error && <p className="text-sm text-danger">{error}</p>}
      <div className="flex gap-2">
        <button
          type="button"
          disabled={confirmText !== "DELETE" || isPending}
          onClick={handleDelete}
          className="btn-primary !bg-danger text-sm disabled:opacity-50"
        >
          {isPending ? "Deleting…" : "Permanently delete my account"}
        </button>
        <button type="button" onClick={() => setConfirming(false)} disabled={isPending} className="btn-secondary text-sm">
          Cancel
        </button>
      </div>
    </div>
  );
}
