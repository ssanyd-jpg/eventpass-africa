"use client";

import { Suspense, useState } from "react";
import { signIn, getSession } from "next-auth/react";
import { useRouter, useSearchParams } from "next/navigation";
import Link from "next/link";
import { useOnlineStatus } from "@/lib/sync-engine";
import { useTranslation } from "@/lib/use-translation";
import { getPostLoginRedirect } from "@/lib/auth-redirect";
import PasswordInput from "@/components/PasswordInput";

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

  // Attendee-only alternative to email+password, same buyer-otp provider
  // and /api/phone-otp/send route as the checkout panel in
  // EventDetailClient.tsx. Defaults to phone: most attendees from here on
  // are phone-only accounts (created via inline OTP at checkout) and have
  // no password to type in the first place. Organisers never get this —
  // there's no organiser-side OTP, so that tab always shows the form below.
  const [authMode, setAuthMode] = useState<"phone" | "password">("phone");
  const [buyerPhone, setBuyerPhone] = useState("");
  const [codeSent, setCodeSent] = useState(false);
  const [otpCode, setOtpCode] = useState("");
  const [otpSending, setOtpSending] = useState(false);
  const [otpVerifying, setOtpVerifying] = useState(false);
  const [otpError, setOtpError] = useState<string | null>(null);
  const [resendAt, setResendAt] = useState(0);

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

  async function sendOtp() {
    setOtpSending(true);
    setOtpError(null);
    const res = await fetch("/api/phone-otp/send", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ phone: buyerPhone.trim() }),
    });
    setOtpSending(false);
    if (!res.ok) {
      const data = await res.json().catch(() => null);
      setOtpError(data?.error ?? t("login.phoneErrorRateLimited"));
      return;
    }
    setCodeSent(true);
    setResendAt(Date.now() + 60_000);
  }

  async function verifyOtp() {
    setOtpVerifying(true);
    setOtpError(null);
    // Deliberately no name/email here, unlike EventDetailClient's checkout
    // panel — this tab is for logging back into an account that already
    // exists, never for creating one. A phone with no existing account
    // throws "no_account" below (see OtpNoAccountSignin in auth.ts) rather
    // than silently signing someone up with no name/email to give it.
    const res = await signIn("buyer-otp", {
      phone: buyerPhone.trim(),
      code: otpCode.trim(),
      name: "",
      email: "",
      redirect: false,
    });
    setOtpVerifying(false);
    if (res?.error) {
      setOtpError(
        res.code === "too_many_attempts"
          ? t("login.phoneErrorTooManyAttempts")
          : res.code === "already_used"
            ? t("login.phoneErrorAlreadyUsed")
            : res.code === "expired"
              ? t("login.phoneErrorExpired")
              : res.code === "account_has_password"
                ? t("login.phoneErrorAccountHasPassword")
                : res.code === "no_account"
                  ? t("login.phoneErrorNoAccount")
                  : res.code === "rate_limited"
                    ? t("login.phoneErrorRateLimited")
                    : t("login.phoneErrorInvalidCode")
      );
      return;
    }
    const session = await getSession();
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

      {loginIntent === "attendee" && authMode === "phone" ? (
        <div className="card space-y-4 p-6">
          {!codeSent ? (
            <>
              <div>
                <label className="label" htmlFor="buyerPhone">{t("login.phoneLabel")}</label>
                <input
                  id="buyerPhone"
                  className="input"
                  placeholder={t("login.phonePlaceholder")}
                  value={buyerPhone}
                  onChange={(e) => setBuyerPhone(e.target.value)}
                />
              </div>
              {otpError && <p className="text-sm text-danger">{otpError}</p>}
              <button
                type="button"
                className="btn-primary w-full"
                disabled={otpSending || buyerPhone.trim().length < 6}
                onClick={sendOtp}
              >
                {otpSending ? t("login.sendingCode") : t("login.sendCode")}
              </button>
            </>
          ) : (
            <>
              <p className="text-xs text-muted">{t("login.codeSentHint", { phone: buyerPhone.trim() })}</p>
              <div>
                <label className="label" htmlFor="otpCode">{t("login.codeLabel")}</label>
                <input
                  id="otpCode"
                  className="input"
                  inputMode="numeric"
                  maxLength={6}
                  value={otpCode}
                  onChange={(e) => setOtpCode(e.target.value.replace(/\D/g, ""))}
                />
              </div>
              {otpError && <p className="text-sm text-danger">{otpError}</p>}
              <button
                type="button"
                className="btn-primary w-full"
                disabled={otpVerifying || otpCode.trim().length !== 6}
                onClick={verifyOtp}
              >
                {otpVerifying ? t("login.verifying") : t("login.verifyAndLogIn")}
              </button>
              <button
                type="button"
                className="w-full text-xs text-muted underline disabled:no-underline disabled:opacity-50"
                disabled={otpSending || Date.now() < resendAt}
                onClick={sendOtp}
              >
                {Date.now() < resendAt
                  ? t("login.resendCodeCooldown", { seconds: Math.ceil((resendAt - Date.now()) / 1000) })
                  : t("login.resendCode")}
              </button>
            </>
          )}
          <button
            type="button"
            className="block w-full text-center text-xs text-muted hover:text-foreground"
            onClick={() => setAuthMode("password")}
          >
            {t("login.usePasswordInstead")}
          </button>
        </div>
      ) : (
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
            <PasswordInput
              id="password"
              required
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
          {loginIntent === "attendee" && (
            <button
              type="button"
              className="block w-full text-center text-xs text-muted hover:text-foreground"
              onClick={() => setAuthMode("phone")}
            >
              {t("login.usePhoneInstead")}
            </button>
          )}
        </form>
      )}

      {/* Dev/staging convenience only — was rendering unconditionally,
          including on the production domain, which put three real working
          logins (one of them platform admin) in plain text on a public
          page. NODE_ENV is "production" on every real deploy (Vercel sets
          it automatically) and inlined at build time for a client
          component, so this never ships to production regardless of how
          it's hosted. */}
      {process.env.NODE_ENV !== "production" && (
        <div className="mt-4 rounded-lg border border-border bg-surface p-4 text-xs text-muted">
          <p className="mb-1 font-semibold text-foreground">{t("login.demoAccounts")}</p>
          {/* Passwords were rotated by scripts/rotate-demo-passwords.ts after
              being exposed in plain text here — see that script's own
              header comment for why. Emails are still fine to list (they're
              not a secret), the password column just points at wherever
              rotate-demo-passwords.ts's one-time printout actually landed. */}
          <p>organizer@chaap.dev — see your password manager</p>
          <p>fan@chaap.dev — see your password manager</p>
          <p>admin@chaap.dev — see your password manager</p>
        </div>
      )}

      <p className="mt-6 text-center text-sm text-muted">
        {t("login.noAccount")}{" "}
        <Link href="/register" className="font-medium text-accent-hover">
          {t("login.signUp")}
        </Link>
      </p>
    </div>
  );
}
