"use client";

import { useEffect, useState } from "react";
import { useOnlineStatus, usePendingCount, onSyncTick } from "@/lib/sync-engine";

export default function SyncStatusBadge() {
  const online = useOnlineStatus();
  const pending = usePendingCount();
  const [pulse, setPulse] = useState(false);

  useEffect(() => {
    return onSyncTick(() => {
      setPulse(true);
      setTimeout(() => setPulse(false), 700);
    });
  }, []);

  let dotColor = "bg-ok";
  let label = "Online";
  if (!online) {
    dotColor = "bg-danger";
    label = "Offline";
  } else if (pending > 0) {
    dotColor = "bg-warn";
    label = "Syncing";
  }

  return (
    <div className="pill gap-2" title={online ? "Connected to EventPass Africa cloud" : "No connectivity — working from local data"}>
      <span
        className={`h-2 w-2 rounded-full ${dotColor} ${pulse ? "animate-ping" : ""}`}
        style={{ boxShadow: pulse ? "none" : `0 0 0 3px transparent` }}
      />
      <span>{label}</span>
      {pending > 0 && (
        <span className="rounded-full bg-warn/20 px-1.5 py-0.5 text-[10px] font-semibold text-warn">
          {pending} pending
        </span>
      )}
    </div>
  );
}
