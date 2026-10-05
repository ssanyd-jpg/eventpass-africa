"use client";

import { useEffect, useState } from "react";
import { useTranslation } from "@/lib/use-translation";

// One-shot, set by the register page right before it redirects a brand-new
// signup to their landing page (/events for an attendee, /dashboard/events/new
// for an organiser) — sessionStorage rather than a query param, so the
// landing page doesn't need its own Suspense boundary just to read it, and
// it naturally can't survive being shared/bookmarked/reloaded.
const KEY = "eventpass-africa:welcome-message";

export function setWelcomeFlag(kind: "attendee" | "organiser") {
  try {
    sessionStorage.setItem(KEY, kind);
  } catch {
    // Private-browsing/storage-blocked — the welcome banner just won't show.
  }
}

export default function WelcomeBanner({ expected }: { expected: "attendee" | "organiser" }) {
  const { t } = useTranslation();
  const [show, setShow] = useState(false);

  useEffect(() => {
    try {
      if (sessionStorage.getItem(KEY) === expected) {
        setShow(true);
        sessionStorage.removeItem(KEY);
      }
    } catch {
      // ignore
    }
  }, [expected]);

  if (!show) return null;

  return (
    <div className="mb-6 rounded-lg border border-accent/40 bg-accent-soft px-4 py-3 text-sm text-foreground">
      {expected === "attendee" ? t("register.welcomeAttendee") : t("register.welcomeOrganiser")}
    </div>
  );
}
