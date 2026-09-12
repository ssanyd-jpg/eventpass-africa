"use client";

import { useEffect, useState } from "react";
import { useParams } from "next/navigation";
import { signIn } from "next-auth/react";
import Link from "next/link";

// Consumes the magic link token exactly once — see
// consumeSponsorMagicLinkToken in src/lib/sponsor-auth.ts, invoked here via
// the "sponsor-magic-link" Credentials provider's authorize(). Same
// single-use-token/hard-navigation shape as the vendor verify page.
export default function SponsorVerifyPage() {
  const { token } = useParams<{ token: string }>();
  const [status, setStatus] = useState<"checking" | "failed">("checking");

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const res = await signIn("sponsor-magic-link", { token, redirect: false });
      if (cancelled) return;
      if (res?.error) {
        setStatus("failed");
        return;
      }
      // The session now carries sponsorId — a plain page navigation (not
      // router.push) forces a fresh server request so middleware sees the
      // just-established cookie immediately, same reasoning the vendor
      // verify page covers.
      window.location.href = "/sponsor";
    })();
    return () => {
      cancelled = true;
    };
  }, [token]);

  if (status === "failed") {
    return (
      <div className="mx-auto flex min-h-[80vh] max-w-sm flex-col justify-center px-5 py-10 text-center">
        <h1 className="text-2xl font-bold">This link is invalid or has expired</h1>
        <p className="mt-2 text-base text-muted">Magic links work once and expire after 24 hours — ask for a new one.</p>
        <Link href="/sponsor/login" className="btn-primary mt-6 !h-14 !text-lg">Get a new link</Link>
      </div>
    );
  }

  return <div className="flex min-h-[80vh] items-center justify-center text-lg text-muted">Signing you in…</div>;
}
