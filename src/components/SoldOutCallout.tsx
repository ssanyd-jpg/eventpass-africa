"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useTranslation } from "@/lib/use-translation";

// Dismissal persists per ticket type, same localStorage-survives-reload
// convention as HomeOrganiserBanner.tsx/InstallPrompt.tsx — a Set (not a
// single flag) since more than one ticket type on the same event can be
// sold out at once, each dismissible independently.
const DISMISSED_KEY = "eventpass-africa:sold-out-dismissed";

function readDismissed(): Set<string> {
  try {
    const raw = localStorage.getItem(DISMISSED_KEY);
    return new Set(raw ? (JSON.parse(raw) as string[]) : []);
  } catch {
    return new Set();
  }
}

export default function SoldOutCallout({
  eventId,
  ticketTypeId,
  ticketTypeName,
}: {
  eventId: string;
  ticketTypeId: string;
  ticketTypeName: string;
}) {
  const { t } = useTranslation();
  const [dismissed, setDismissed] = useState(true);

  useEffect(() => {
    setDismissed(readDismissed().has(ticketTypeId));
  }, [ticketTypeId]);

  if (dismissed) return null;

  function dismiss() {
    try {
      const next = readDismissed();
      next.add(ticketTypeId);
      localStorage.setItem(DISMISSED_KEY, JSON.stringify(Array.from(next)));
    } catch {
      // ignore — worst case it reappears next load
    }
    setDismissed(true);
  }

  return (
    <div className="mt-3 flex flex-wrap items-center justify-between gap-3 rounded-lg border border-warn/40 bg-warn/10 px-4 py-3 text-sm text-warn">
      <span>
        {t("dashboard.soldOutCallout", { ticketTypeName })}{" "}
        <Link href={`/dashboard/events/${eventId}/edit`} className="font-medium underline">
          {t("dashboard.editTicketsLink")}
        </Link>
      </span>
      <button
        type="button"
        onClick={dismiss}
        aria-label="Dismiss"
        className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full hover:bg-black/10"
      >
        ✕
      </button>
    </div>
  );
}
