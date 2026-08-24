"use client";

import { Suspense, useState } from "react";
import { signIn } from "next-auth/react";
import { useRouter, useSearchParams } from "next/navigation";
import Link from "next/link";
import { useOnlineStatus } from "@/lib/sync-engine";
import { useTranslation } from "@/lib/use-translation";

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

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setLoading(true);
    const res = await signIn("credentials", { redirect: false, email, password });
    setLoading(false);
    if (res?.error) {
      setError("Invalid email or password.");
      return;
    }
    router.push(params.get("callbackUrl") || "/");
    router.refresh();
  }

  return (
    <div className="mx-auto flex min-h-[70vh] max-w-md flex-col justify-center px-4 py-12">
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src="/icon.svg" alt="" className="mb-4 h-12 w-12 rounded-xl" />
      <h1 className="mb-1 text-2xl font-bold">{t("login.welcomeBack")}</h1>
      <p className="mb-6 text-sm text-muted">{t("login.subtitle")}</p>

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
        <p>organizer@eventpassafrica.dev / password123 (organizer)</p>
        <p>fan@eventpassafrica.dev / password123 (attendee)</p>
        <p>admin@eventpassafrica.dev / password123 (admin)</p>
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
