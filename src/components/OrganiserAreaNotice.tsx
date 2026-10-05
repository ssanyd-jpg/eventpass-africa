"use client";

import { useTranslation } from "@/lib/use-translation";

// Shown on /events when middleware bounces an attendee-flagged account away
// from /dashboard/* or /scan/* (see resolveAttendeeRedirect in
// src/lib/attendee-access.ts) — `show` comes from the server-rendered
// ?notice=organiser-only query param (read in page.tsx's searchParams, not
// useSearchParams here) so this needs no Suspense boundary of its own.
export default function OrganiserAreaNotice({ show }: { show: boolean }) {
  const { t } = useTranslation();
  if (!show) return null;

  return (
    <div className="mb-6 rounded-lg border border-warn/40 bg-warn/10 px-4 py-3 text-sm text-warn">
      {t("events.organiserAreaNotice")}
    </div>
  );
}
