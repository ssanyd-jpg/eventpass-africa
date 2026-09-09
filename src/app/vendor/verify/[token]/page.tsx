"use client";

import { useEffect, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import { signIn } from "next-auth/react";
import Link from "next/link";

// Consumes the magic link token exactly once — see
// consumeVendorMagicLinkToken in src/lib/vendor-auth.ts, invoked here via
// the "vendor-magic-link" Credentials provider's authorize(). A second load
// of this same URL (a bookmark, an email client's link-prefetch) correctly
// fails, since the token is already used by then.
export default function VendorVerifyPage() {
  const { token } = useParams<{ token: string }>();
  const router = useRouter();
  const [status, setStatus] = useState<"checking" | "failed">("checking");

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const res = await signIn("vendor-magic-link", { token, redirect: false });
      if (cancelled) return;
      if (res?.error) {
        setStatus("failed");
        return;
      }
      // The session now carries vendorId — a plain page navigation (not
      // router.push) forces a fresh server request so middleware sees the
      // just-established cookie immediately, same reasoning login/page.tsx
      // covers with its router.refresh() after signIn.
      window.location.href = "/vendor";
    })();
    return () => {
      cancelled = true;
    };
  }, [token, router]);

  if (status === "failed") {
    return (
      <div className="mx-auto flex min-h-[80vh] max-w-sm flex-col justify-center px-5 py-10 text-center">
        <h1 className="text-2xl font-bold">This link is invalid or has expired</h1>
        <p className="mt-2 text-base text-muted">Magic links work once and expire after 24 hours — ask for a new one.</p>
        <Link href="/vendor/login" className="btn-primary mt-6 !h-14 !text-lg">Get a new link</Link>
      </div>
    );
  }

  return <div className="flex min-h-[80vh] items-center justify-center text-lg text-muted">Signing you in…</div>;
}
