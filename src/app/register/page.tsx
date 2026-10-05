"use client";

import { useState } from "react";
import { signIn } from "next-auth/react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { useOnlineStatus } from "@/lib/sync-engine";
import { useTranslation } from "@/lib/use-translation";
import { setWelcomeFlag } from "@/components/WelcomeBanner";
import { getPostSignupRedirect, type AccountType } from "@/lib/auth-redirect";

export default function RegisterPage() {
  const router = useRouter();
  const online = useOnlineStatus();
  const { t } = useTranslation();
  // null = still on the "I want to…" choice step, shown before the form
  // itself — the two paths differ in both the fields collected (organiser
  // adds a company name) and what happens after signup (org flag, welcome
  // message, redirect target — see onSubmit below).
  const [accountType, setAccountType] = useState<AccountType | null>(null);
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [organizationName, setOrganizationName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!accountType) return;
    setError(null);
    setLoading(true);
    try {
      const res = await fetch("/api/register", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name,
          email,
          password,
          accountType,
          organizationName: accountType === "ORGANISER" ? organizationName.trim() : undefined,
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error ?? "Something went wrong");
        setLoading(false);
        return;
      }
      const signInRes = await signIn("credentials", { redirect: false, email, password });
      setLoading(false);
      if (signInRes?.error) {
        router.push("/login");
        return;
      }
      setWelcomeFlag(accountType === "ATTENDEE" ? "attendee" : "organiser");
      router.push(getPostSignupRedirect(accountType));
      router.refresh();
    } catch {
      setError("Couldn't reach the server — creating an account requires a connection.");
      setLoading(false);
    }
  }

  // Step 1 — choose a path. Both lead to the same form below, just with a
  // different field set and a different post-signup destination.
  if (!accountType) {
    return (
      <div className="mx-auto flex min-h-[70vh] max-w-md flex-col justify-center px-4 py-12">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src="/chaap-icon.webp" alt="" className="mb-4 h-12 w-12 rounded-xl" />
        <h1 className="mb-1 text-2xl font-bold">Create your account</h1>
        <p className="mb-6 text-sm text-muted">{t("register.choosePathHeading")}</p>

        <div className="flex flex-col gap-3">
          <button
            type="button"
            onClick={() => setAccountType("ATTENDEE")}
            className="card p-5 text-left text-base font-semibold transition hover:border-accent"
          >
            {t("register.pathAttendee")}
          </button>
          <button
            type="button"
            onClick={() => setAccountType("ORGANISER")}
            className="card p-5 text-left text-base font-semibold transition hover:border-accent"
          >
            {t("register.pathOrganiser")}
          </button>
        </div>

        <p className="mt-6 text-center text-sm text-muted">
          Already have an account?{" "}
          <Link href="/login" className="font-medium text-accent-hover">
            Log in
          </Link>
        </p>
      </div>
    );
  }

  // Step 2 — the form itself, shaped by the chosen path.
  return (
    <div className="mx-auto flex min-h-[70vh] max-w-md flex-col justify-center px-4 py-12">
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src="/chaap-icon.webp" alt="" className="mb-4 h-12 w-12 rounded-xl" />
      <div className="mb-1 flex items-center justify-between gap-3">
        <h1 className="text-2xl font-bold">Create your account</h1>
        <button
          type="button"
          onClick={() => setAccountType(null)}
          className="shrink-0 text-xs font-medium text-accent-hover"
        >
          {t("register.changePath")}
        </button>
      </div>
      <p className="mb-6 text-sm text-muted">
        {accountType === "ATTENDEE" ? t("register.pathAttendee") : t("register.pathOrganiser")}
      </p>

      {!online && (
        <p className="mb-4 rounded-lg border border-warn/40 bg-warn/10 px-3 py-2 text-sm text-warn">
          You&apos;re offline. Creating a new account needs a connection the
          first time.
        </p>
      )}

      <form onSubmit={onSubmit} className="card space-y-4 p-6">
        <div>
          <label className="label" htmlFor="name">Full name</label>
          <input id="name" required className="input" value={name} onChange={(e) => setName(e.target.value)} />
        </div>
        {accountType === "ORGANISER" && (
          <div>
            <label className="label" htmlFor="organizationName">{t("register.organisationNameLabel")}</label>
            <input
              id="organizationName"
              required
              className="input"
              placeholder={t("register.organisationNamePlaceholder")}
              value={organizationName}
              onChange={(e) => setOrganizationName(e.target.value)}
            />
          </div>
        )}
        <div>
          <label className="label" htmlFor="email">Email</label>
          <input id="email" type="email" required className="input" value={email} onChange={(e) => setEmail(e.target.value)} />
        </div>
        <div>
          <label className="label" htmlFor="password">Password</label>
          <input id="password" type="password" required minLength={8} className="input" value={password} onChange={(e) => setPassword(e.target.value)} />
          <p className="mt-1 text-xs text-muted">At least 8 characters.</p>
        </div>
        {error && <p className="text-sm text-danger">{error}</p>}
        <button type="submit" disabled={loading} className="btn-primary w-full">
          {loading ? "Creating account…" : "Sign up"}
        </button>
      </form>

      <p className="mt-6 text-center text-sm text-muted">
        Already have an account?{" "}
        <Link href="/login" className="font-medium text-accent-hover">
          Log in
        </Link>
      </p>
    </div>
  );
}
