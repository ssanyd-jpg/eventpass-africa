"use client";

import { useState } from "react";
import { signIn } from "next-auth/react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { useOnlineStatus } from "@/lib/sync-engine";

export default function RegisterPage() {
  const router = useRouter();
  const online = useOnlineStatus();
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setLoading(true);
    try {
      const res = await fetch("/api/register", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, email, password }),
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
      router.push("/");
      router.refresh();
    } catch {
      setError("Couldn't reach the server — creating an account requires a connection.");
      setLoading(false);
    }
  }

  return (
    <div className="mx-auto flex min-h-[70vh] max-w-md flex-col justify-center px-4 py-12">
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src="/icon.svg" alt="" className="mb-4 h-12 w-12 rounded-xl" />
      <h1 className="mb-1 text-2xl font-bold">Create your account</h1>
      <p className="mb-6 text-sm text-muted">
        Buy tickets or start selling your own — takes under a minute.
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
