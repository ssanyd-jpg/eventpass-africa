"use client";

import { useState } from "react";
import { useParams, useRouter } from "next/navigation";
import { useSession } from "next-auth/react";
import Link from "next/link";
import { useAppSession } from "@/lib/use-app-session";
import { pullFromServer } from "@/lib/sync-engine";

export default function AcceptInvitePage() {
  const { token } = useParams<{ token: string }>();
  const router = useRouter();
  const { user, status } = useAppSession();
  const { update } = useSession();
  const [error, setError] = useState<string | null>(null);
  const [accepting, setAccepting] = useState(false);
  const [organizationName, setOrganizationName] = useState<string | null>(null);

  async function accept() {
    setAccepting(true);
    setError(null);
    const res = await fetch("/api/organization/accept", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token }),
    });
    const data = await res.json();
    if (!res.ok || !data.ok) {
      setError(data.error ?? "Something went wrong.");
      setAccepting(false);
      return;
    }
    setOrganizationName(data.organizationName);
    // update() with no argument only refetches the existing session (a
    // plain GET) — it must be called with a data object to POST and
    // actually trigger auth.ts's `trigger === "update"` branch, which is
    // what re-reads the membership after this accept.
    await update({ organizationAccepted: true });
    await pullFromServer();
    setTimeout(() => router.push("/dashboard"), 1500);
  }

  if (status === "loading") return null;

  if (!user) {
    return (
      <div className="mx-auto flex min-h-[70vh] max-w-md flex-col justify-center px-4 py-12 text-center">
        <p className="mb-4 text-sm text-muted">Sign in to accept this team invite.</p>
        <Link href={`/login?callbackUrl=/team/accept/${token}`} className="btn-primary">Sign in</Link>
      </div>
    );
  }

  return (
    <div className="mx-auto flex min-h-[70vh] max-w-md flex-col justify-center px-4 py-12">
      <h1 className="mb-1 text-2xl font-bold">Join a team</h1>
      {organizationName ? (
        <div className="card mt-4 p-6 text-sm">
          <p className="text-ok">You&apos;ve joined {organizationName} — redirecting…</p>
        </div>
      ) : (
        <div className="card mt-4 space-y-4 p-6">
          <p className="text-sm text-muted">
            Accept this invite as <span className="font-medium text-foreground">{user.email}</span>.
          </p>
          {error && <p className="text-sm text-danger">{error}</p>}
          <button type="button" disabled={accepting} className="btn-primary w-full" onClick={accept}>
            {accepting ? "Joining…" : "Accept invite"}
          </button>
        </div>
      )}
    </div>
  );
}
