"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import type { TicketGroupState } from "@/lib/whatsapp-group";
import { joinWhatsappGroup, leaveWhatsappGroup } from "./actions";

export default function WhatsappGroupControl({
  ticketId,
  eventTitle,
  group,
}: {
  ticketId: string;
  eventTitle: string;
  group: TicketGroupState;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onJoin() {
    setBusy(true);
    setError(null);
    try {
      const result = await joinWhatsappGroup(ticketId);
      if (!result.sent && result.reason === "NO_PHONE") {
        setError("Add a phone number to your account to receive the invite link.");
        return;
      }
      router.refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't join the group.");
    } finally {
      setBusy(false);
    }
  }

  async function onLeave() {
    setBusy(true);
    setError(null);
    try {
      await leaveWhatsappGroup(ticketId);
      router.refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't update your opt-in.");
    } finally {
      setBusy(false);
    }
  }

  if (group.optedIn && group.inviteSentAt) {
    return (
      <div className="card space-y-3 p-5">
        <p>You&apos;re in the {eventTitle} WhatsApp group ✅</p>
        {error && <p className="text-sm text-danger">{error}</p>}
        <button className="btn-secondary" disabled={busy} onClick={onLeave}>
          {busy ? "Saving…" : "Leave the group"}
        </button>
      </div>
    );
  }

  if (group.optedIn) {
    return (
      <div className="card space-y-3 p-5">
        <p className="text-sm text-muted">You&apos;re opted in — your invite link is on its way.</p>
        {error && <p className="text-sm text-danger">{error}</p>}
        <button className="btn-secondary" disabled={busy} onClick={onLeave}>
          {busy ? "Saving…" : "Opt out"}
        </button>
      </div>
    );
  }

  return (
    <div className="card space-y-3 p-5">
      <p className="text-sm text-muted">Connect with other attendees and get updates from the organiser.</p>
      {error && <p className="text-sm text-danger">{error}</p>}
      <button className="btn-primary" disabled={busy} onClick={onJoin}>
        {busy ? "Joining…" : "Join the WhatsApp group"}
      </button>
    </div>
  );
}
