import { redirect } from "next/navigation";
import Link from "next/link";
import { auth } from "@/auth";
import { getSurveyEvent, getSurveyResults } from "@/lib/survey-handlers";
import SurveySummary from "./SurveySummary";

export default async function SurveyResultsPage({ params }: { params: { id: string } }) {
  const session = await auth();
  if (!session?.user?.id) {
    redirect(`/login?callbackUrl=/dashboard/events/${params.id}/surveys`);
  }
  if (session.user.organizationRole === "GATE_CREW") {
    redirect("/dashboard");
  }

  const event = await getSurveyEvent(session.user.organizationId, params.id);
  if (!event) {
    return (
      <div className="mx-auto max-w-3xl px-4 pb-20 pt-8 text-center sm:px-6">
        <p className="font-semibold">Event not found on your organization.</p>
      </div>
    );
  }

  const results = (await getSurveyResults(session.user.organizationId, params.id)) ?? [];
  const totalResponses = results.length > 0 ? Math.max(...results.map((r) => r.values.length)) : 0;

  return (
    <div className="mx-auto max-w-3xl px-4 pb-20 pt-8 sm:px-6">
      <Link href={`/dashboard/events/${event.id}`} className="text-sm text-muted hover:text-foreground">
        ← {event.title}
      </Link>
      <div className="mt-3 flex items-center justify-between">
        <h1 className="text-2xl font-bold">Survey results</h1>
        {totalResponses > 0 && (
          <a href={`/api/dashboard/events/${event.id}/surveys/export`} className="btn-secondary">
            Export CSV
          </a>
        )}
      </div>
      <p className="mb-6 mt-1 text-sm text-muted">
        Add questions from this event&apos;s edit page — buyers are invited
        to respond once the event is at least 24 hours past.
      </p>

      {results.length === 0 ? (
        <div className="card p-8 text-center text-muted">No survey questions on this event yet.</div>
      ) : (
        <div className="space-y-4">
          {results.map((r) => (
            <div key={r.questionId} className="card p-4">
              <p className="mb-2 font-medium">{r.label}</p>
              {r.values.length === 0 ? (
                <p className="text-sm text-muted">No responses yet.</p>
              ) : r.type === "TEXT" ? (
                <>
                  <SurveySummary eventId={event.id} questionId={r.questionId} />
                  <ul className="space-y-2 text-sm">
                    {r.values.map((v, i) => (
                      <li key={i} className="rounded-lg bg-surface2 p-2">{v}</li>
                    ))}
                  </ul>
                </>
              ) : (
                <ul className="space-y-1 text-sm">
                  {Object.entries(r.tally).map(([option, count]) => (
                    <li key={option} className="flex justify-between">
                      <span>{option}</span>
                      <span className="text-muted">{count}</span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
