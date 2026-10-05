import Link from "next/link";

// Shown in place of the normal dashboard for an attendee-flagged account
// (isAttendeeOrg) that reaches bare "/dashboard" directly — every
// "/dashboard/*" sub-page instead gets hard-redirected to /events by
// middleware (see resolveAttendeeRedirect in src/lib/attendee-access.ts);
// this is the one organiser surface an attendee can actually land on, so it
// explains why rather than silently redirecting them away from it too.
export default function OrganiserOnlyMessage() {
  return (
    <div className="mx-auto flex min-h-[50vh] max-w-md flex-col items-center justify-center gap-4 px-4 py-16 text-center">
      <span aria-hidden className="text-4xl">🎪</span>
      <div>
        <p className="font-semibold">This area is for event organisers.</p>
        <p className="mt-1 text-sm text-muted">Want to organise events on Chaap?</p>
      </div>
      <div className="flex flex-wrap items-center justify-center gap-3">
        <Link href="/register" className="btn-primary">Create an organiser account →</Link>
        <Link href="/events" className="btn-secondary">Browse events →</Link>
      </div>
    </div>
  );
}
