"use client";

import { useCallback, useEffect, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import Link from "next/link";
import { useAppSession } from "@/lib/use-app-session";
import { setWhatsappGroupSettings, sendGroupInvitesNow, sendGroupArchiveMessageNow } from "./actions";
import { SkeletonPage } from "@/components/Skeleton";

interface WhatsappGroupPageData {
  eventTitle: string;
  whatsappGroupEnabled: boolean;
  whatsappGroupLink: string | null;
  eventEnded: boolean;
  optedInCount: number;
  invitesSentCount: number;
  archivedAt: string | null;
}

export default function EventWhatsappGroupPage() {
  const { id: rawId } = useParams<{ id: string }>();
  const eventId = decodeURIComponent(rawId);
  const router = useRouter();
  const { user } = useAppSession();

  useEffect(() => {
    if (user?.organizationRole === "GATE_CREW") router.replace("/dashboard");
  }, [user, router]);

  const [data, setData] = useState<WhatsappGroupPageData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [enabled, setEnabled] = useState(false);
  const [link, setLink] = useState("");
  const [saving, setSaving] = useState(false);
  const [sendingInvites, setSendingInvites] = useState(false);
  const [sendingArchive, setSendingArchive] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch(`/api/dashboard/events/${eventId}/whatsapp-group`, { cache: "no-store" });
      const body = await res.json();
      if (!res.ok || !body.ok) {
        setError(body.reason ?? "Failed to load");
        return;
      }
      setData(body);
      setEnabled(body.whatsappGroupEnabled);
      setLink(body.whatsappGroupLink ?? "");
    } catch {
      setError("Failed to load");
    }
  }, [eventId]);

  useEffect(() => {
    load();
  }, [load]);

  async function onSave() {
    setNotice(null);
    setSaving(true);
    try {
      await setWhatsappGroupSettings(eventId, enabled, link.trim() || null);
      setNotice("Saved.");
      await load();
    } catch (e) {
      setNotice(e instanceof Error ? e.message : "Couldn't save.");
    } finally {
      setSaving(false);
    }
  }

  async function onSendInvites() {
    setNotice(null);
    setSendingInvites(true);
    try {
      const { sentCount } = await sendGroupInvitesNow(eventId);
      setNotice(`Sent ${sentCount} invite${sentCount === 1 ? "" : "s"}.`);
      await load();
    } catch (e) {
      setNotice(e instanceof Error ? e.message : "Couldn't send invites.");
    } finally {
      setSendingInvites(false);
    }
  }

  async function onSendArchiveMessage() {
    setNotice(null);
    setSendingArchive(true);
    try {
      const result = await sendGroupArchiveMessageNow(eventId);
      setNotice(`Archive message sent to ${result.notifiedCount} attendee${result.notifiedCount === 1 ? "" : "s"}.`);
      await load();
    } catch (e) {
      setNotice(e instanceof Error ? e.message : "Couldn't send the archive message.");
    } finally {
      setSendingArchive(false);
    }
  }

  if (user?.organizationRole === "GATE_CREW") return null;

  if (error) {
    return (
      <div className="mx-auto max-w-3xl px-4 py-16 text-center">
        <p className="text-lg font-semibold">Couldn&apos;t load this event&apos;s WhatsApp group settings.</p>
        <Link href={`/dashboard/events/${eventId}`} className="btn-secondary mt-6 inline-flex">← Back to event</Link>
      </div>
    );
  }

  if (!data) {
    return <SkeletonPage maxWidth="max-w-3xl" />;
  }

  return (
    <div className="mx-auto max-w-3xl px-4 pb-20 pt-8 sm:px-6">
      <Link href={`/dashboard/events/${eventId}`} className="text-sm text-muted hover:text-foreground">
        ← {data.eventTitle}
      </Link>
      <h1 className="mb-1 mt-3 text-2xl font-bold">WhatsApp group</h1>
      <p className="mb-6 text-sm text-muted">
        Give attendees a place to ask questions, share excitement, and get updates from you — all in the app they
        already use every day.
      </p>

      <div className="card mb-6 space-y-5 p-5">
        <div className="flex items-center justify-between gap-4">
          <div>
            <p className="font-medium">Enable WhatsApp group</p>
            <p className="text-sm text-muted">
              Attendees get a &quot;Join the WhatsApp group&quot; option after buying a ticket.
            </p>
          </div>
          <input type="checkbox" checked={enabled} disabled={saving} onChange={(e) => setEnabled(e.target.checked)} />
        </div>

        <div>
          <label className="mb-1 block text-sm font-medium" htmlFor="whatsapp-group-link">
            Group invite link
          </label>
          <input
            id="whatsapp-group-link"
            type="url"
            className="input"
            value={link}
            disabled={saving}
            placeholder="https://chat.whatsapp.com/..."
            onChange={(e) => setLink(e.target.value)}
          />
          <ol className="mt-2 list-decimal space-y-1 pl-5 text-xs text-muted">
            <li>Open WhatsApp on your phone.</li>
            <li>Create a new group.</li>
            <li>Tap the group name → Invite via link → Copy link.</li>
            <li>Paste it here.</li>
          </ol>
        </div>

        <div className="flex items-center gap-3">
          <button className="btn-primary" disabled={saving} onClick={onSave}>
            {saving ? "Saving…" : "Save"}
          </button>
          {notice && <span className="text-sm text-muted">{notice}</span>}
        </div>
      </div>

      <div className="card mb-6 space-y-4 p-5">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <p className="text-sm text-muted">
            {data.optedInCount} attendee{data.optedInCount === 1 ? "" : "s"} opted in · {data.invitesSentCount} invite
            {data.invitesSentCount === 1 ? "" : "s"} sent
          </p>
          <button
            className="btn-secondary"
            disabled={sendingInvites || !data.whatsappGroupEnabled || !data.whatsappGroupLink}
            onClick={onSendInvites}
          >
            {sendingInvites ? "Sending…" : "Send invites now"}
          </button>
        </div>

        {data.eventEnded && (
          <div className="flex flex-wrap items-center justify-between gap-3 border-t border-border pt-4">
            <p className="text-sm text-muted">
              {data.archivedAt ? "Archive message already sent." : "This event has ended."}
            </p>
            <button
              className="btn-secondary disabled:opacity-50"
              disabled={sendingArchive || !!data.archivedAt}
              onClick={onSendArchiveMessage}
            >
              {sendingArchive ? "Sending…" : "Send archive message"}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
