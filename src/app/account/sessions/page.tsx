import { redirect } from "next/navigation";
import { auth } from "@/auth";
import { formatDateTime } from "@/lib/format";
import { listUserSessions } from "@/lib/session-handlers";
import { revokeSession, revokeOtherSessions } from "./actions";

export default async function SessionsPage() {
  const session = await auth();
  if (!session?.user?.id) {
    redirect("/login?callbackUrl=/account/sessions");
  }

  const sessions = await listUserSessions(session.user.id);

  return (
    <div className="mx-auto max-w-2xl px-4 pb-20 pt-8 sm:px-6">
      <h1 className="mb-1 text-2xl font-bold">Login Sessions</h1>
      <p className="mb-6 text-sm text-muted">
        Every device currently signed in to your account. A revoked session may take a
        few minutes to fully sign out on that device.
      </p>

      {sessions.length > 1 && (
        <form action={revokeOtherSessions} className="mb-4">
          <button type="submit" className="btn-secondary text-sm">Sign out all other sessions</button>
        </form>
      )}

      <div className="card divide-y divide-border">
        {sessions.map((s) => {
          const isCurrent = s.id === session.sessionId;
          return (
            <div key={s.id} className="flex items-center justify-between gap-3 p-4 text-sm">
              <div>
                <p className="font-medium">
                  {s.label}
                  {isCurrent && <span className="pill ml-2">This device</span>}
                </p>
                <p className="text-xs text-muted">Last active {formatDateTime(s.lastSeenAt)}</p>
              </div>
              {!isCurrent && (
                <form
                  action={async () => {
                    "use server";
                    await revokeSession(s.id);
                  }}
                >
                  <button type="submit" className="text-xs font-medium text-danger hover:underline">
                    Revoke
                  </button>
                </form>
              )}
            </div>
          );
        })}
        {sessions.length === 0 && <p className="p-6 text-center text-sm text-muted">No active sessions.</p>}
      </div>
    </div>
  );
}
