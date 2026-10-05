"use client";

import { Suspense, useState } from "react";
import { signIn, getSession } from "next-auth/react";
import { useRouter, useSearchParams } from "next/navigation";
import Link from "next/link";
import { useOnlineStatus } from "@/lib/sync-engine";
import { useTranslation } from "@/lib/use-translation";
import { getPostLoginRedirect } from "@/lib/auth-redirect";

export default function LoginPage() {
  return (
    <Suspense fallback={null}>
      <LoginForm />
    </Suspense>
  );
}

function LoginForm() {
  const router = useRouter();
  const params = useSearchParams();
  const online = useOnlineStatus();
  const { t } = useTranslation();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  // Cosmetic framing only — which subtitle shows below. The account's own
  // isAttendeeOrg always decides where login actually lands (see
  // getPostLoginRedirect), so a mismatched click (an organiser-flagged
  // account on the Attendee tab, say) changes nothing about the outcome,
  // only what this page said while they typed. Defaults to Attendee — the
  // more common case of the two.
  const [loginIntent, setLoginIntent] = useState<"attendee" | "organiser">("attendee");

  // callbackUrl is already how every protected page in this app sends a
  // signed-out visitor here (see the many `/login?callbackUrl=...` redirects
  // across src/app) — far more reliable than document.referrer for a client-
  // rendered SPA, where an in-app route change never sets a real referrer.
  // Takes priority over the tab below, same as it takes priority over
  // isAttendeeOrg in getPostLoginRedirect: both are "where did this visit
  // actually come from" signals, stronger than a cosmetic pre-login choice.
  const callbackUrl = params.get("callbackUrl") ?? "";
  const subtitleKey = callbackUrl.startsWith("/events/")
    ? "login.subtitleTicketPurchase"
    : callbackUrl.startsWith("/dashboard")
      ? "login.subtitleOrganiserDashboard"
      : loginIntent === "organiser"
        ? "login.subtitleOrganiser"
        : "login.subtitleAttendee";

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setLoading(true);
    const res = await signIn("credentials", { redirect: false, email, password });
    if (res?.error) {
      setLoading(false);
      setError(
        res.code === "rate_limited"
          ? "Too many login attempts. Please try again in 15 minutes."
          : "Invalid email or password."
      );
      return;
    }
    // signIn({redirect:false}) returns no session data of its own — fetch
    // the fresh session so the real (not tab-guessed) isAttendeeOrg is what
    // decides the destination.
    const session = await getSession();
    setLoading(false);
    router.push(getPostLoginRedirect(session?.user, params.get("callbackUrl")));
    router.refresh();
  }

  return (
    <div className="mx-auto flex min-h-[70vh] max-w-md flex-col justify-center px-4 py-12">
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src="/chaap-icon.webp" alt="" className="mb-4 h-12 w-12 rounded-xl" />
      <h1 className="mb-1 text-2xl font-bold">{t("login.welcomeBack")}</h1>

      <div className="mb-3 inline-flex w-fit rounded-lg border border-border bg-surface2 p-1 text-sm">
        <button
          type="button"
          aria-pressed={loginIntent === "attendee"}
          onClick={() => setLoginIntent("attendee")}
          className={`rounded-md px-3 py-1.5 font-medium transition ${
            loginIntent === "attendee" ? "bg-surface shadow-sm" : "text-muted"
          }`}
        >
          {t("login.tabAttendee")}
        </button>
        <button
          type="button"
          aria-pressed={loginIntent === "organiser"}
          onClick={() => setLoginIntent("organiser")}
          className={`rounded-md px-3 py-1.5 font-medium transition ${
            loginIntent === "organiser" ? "bg-surface shadow-sm" : "text-muted"
          }`}
        >
          {t("login.tabOrganiser")}
        </button>
      </div>

      <p className="mb-6 text-sm text-muted">{t(subtitleKey)}</p>

      {!online && (
        <p className="mb-4 rounded-lg border border-warn/40 bg-warn/10 px-3 py-2 text-sm text-warn">
          {t("login.offlineNotice")}
        </p>
      )}

      <form onSubmit={onSubmit} className="card space-y-4 p-6">
        <div>
          <label className="label" htmlFor="email">{t("login.email")}</label>
          <input
            id="email"
            type="email"
            required
            className="input"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
          />
        </div>
        <div>
          <label className="label" htmlFor="password">{t("login.password")}</label>
          <input
            id="password"
            type="password"
            required
            className="input"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
        </div>
        {error && <p className="text-sm text-danger">{error}</p>}
        <button type="submit" disabled={loading} className="btn-primary w-full">
          {loading ? t("login.signingIn") : t("login.logIn")}
        </button>
        <Link href="/forgot-password" className="block text-center text-xs text-muted hover:text-foreground">
          {t("login.forgotPassword")}
        </Link>
      </form>

      <div className="mt-4 rounded-lg border border-border bg-surface p-4 text-xs text-muted">
        <p className="mb-1 font-semibold text-foreground">{t("login.demoAccounts")}</p>
        <p>organizer@chaap.dev / password123 (organizer)</p>
        <p>fan@chaap.dev / password123 (attendee)</p>
        <p>admin@chaap.dev / password123 (admin)</p>
      </div>

      <p className="mt-6 text-center text-sm text-muted">
        {t("login.noAccount")}{" "}
        <Link href="/register" className="font-medium text-accent-hover">
          {t("login.signUp")}
        </Link>
      </p>
    </div>
  );
}
