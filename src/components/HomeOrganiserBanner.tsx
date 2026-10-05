"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useAppSession } from "@/lib/use-app-session";

// Persisted the same way InstallPrompt.tsx remembers its own dismissal —
// once someone closes this, it stays closed on this device rather than
// reappearing on every visit.
const DISMISSED_KEY = "eventpass-africa:organiser-banner-dismissed";

export default function HomeOrganiserBanner() {
  const { user } = useAppSession();
  const [dismissed, setDismissed] = useState(true);

  useEffect(() => {
    setDismissed(localStorage.getItem(DISMISSED_KEY) === "1");
  }, []);

  if (!user || dismissed) return null;

  return (
    <div className="flex items-center justify-between gap-3 border-b border-accent/40 bg-accent-soft px-4 py-2.5 text-sm text-foreground sm:px-6">
      <Link href="/dashboard" className="min-w-0 truncate font-medium">
        Welcome back, {user.name} — Go to your dashboard →
      </Link>
      <button
        type="button"
        onClick={() => {
          localStorage.setItem(DISMISSED_KEY, "1");
          setDismissed(true);
        }}
        aria-label="Dismiss"
        className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-muted hover:bg-black/10 hover:text-foreground"
      >
        ✕
      </button>
    </div>
  );
}
