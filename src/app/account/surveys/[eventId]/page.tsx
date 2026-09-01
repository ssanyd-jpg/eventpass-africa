"use client";

import { useState } from "react";
import { useLiveQuery } from "dexie-react-hooks";
import { useParams, useRouter } from "next/navigation";
import Link from "next/link";
import { db } from "@/lib/db";
import { useAppSession } from "@/lib/use-app-session";
import QuestionFields from "@/components/QuestionFields";

// Reads its questions straight from the cached pendingSurveys entry — no
// extra fetch needed, this page only ever exists because pullFromServer
// already delivered the questions (see the lazy trigger in
// src/app/api/sync/pull/route.ts).
export default function SurveyResponsePage() {
  const { eventId } = useParams<{ eventId: string }>();
  const router = useRouter();
  const { user, status } = useAppSession();
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const pending = useLiveQuery(() => db.pendingSurveys.get(eventId), [eventId]);

  if (status !== "loading" && !user) {
    router.push(`/login?callbackUrl=/account/surveys/${eventId}`);
    return null;
  }

  if (pending === undefined) {
    return <div className="mx-auto max-w-2xl px-4 py-16 text-center text-muted">Loading…</div>;
  }

  if (!pending) {
    return (
      <div className="mx-auto max-w-2xl px-4 pb-20 pt-8 text-center sm:px-6">
        <p className="font-semibold">No pending survey for this event.</p>
        <p className="mt-2 text-sm text-muted">It may already be answered, or requires a connection to load.</p>
        <Link href="/account/tickets" className="btn-secondary mt-6 inline-flex">My Tickets</Link>
      </div>
    );
  }

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    const requiredMissing = pending!.questions.some((q) => q.required && !(answers[q.id] ?? "").trim());
    if (requiredMissing) {
      setError("Please answer all required questions.");
      return;
    }
    setSubmitting(true);
    try {
      const res = await fetch(`/api/surveys/${eventId}/respond`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          answers: pending!.questions.map((q) => ({ questionId: q.id, value: answers[q.id] ?? "" })),
        }),
      });
      const data = await res.json();
      if (!res.ok || !data.ok) {
        setError(data.error ?? "Couldn't submit — try again.");
        setSubmitting(false);
        return;
      }
      await db.pendingSurveys.delete(eventId);
      router.push("/account/tickets");
    } catch {
      setError("Couldn't reach the server — try again once you're online.");
      setSubmitting(false);
    }
  }

  return (
    <div className="mx-auto max-w-2xl px-4 pb-20 pt-8 sm:px-6">
      <Link href="/account/tickets" className="text-sm text-muted hover:text-foreground">← My Tickets</Link>
      <h1 className="mb-1 mt-3 text-2xl font-bold">How was {pending.eventTitle}?</h1>
      <p className="mb-6 text-sm text-muted">A few quick questions from the organizer.</p>

      <form onSubmit={onSubmit} className="card space-y-4 p-6">
        <QuestionFields
          questions={pending.questions}
          answers={answers}
          onChange={(questionId, value) => setAnswers((a) => ({ ...a, [questionId]: value }))}
        />
        {error && <p className="text-sm text-danger">{error}</p>}
        <button type="submit" disabled={submitting} className="btn-primary w-full">
          {submitting ? "Sending…" : "Submit"}
        </button>
      </form>
    </div>
  );
}
