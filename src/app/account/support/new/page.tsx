import { redirect } from "next/navigation";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { createTicket } from "../actions";

export default async function NewSupportTicketPage({
  searchParams,
}: {
  searchParams: { eventId?: string };
}) {
  const session = await auth();
  const eventId = searchParams.eventId;
  if (!session?.user?.id) {
    redirect(`/login?callbackUrl=/account/support/new${eventId ? `?eventId=${eventId}` : ""}`);
  }

  if (!eventId) {
    return (
      <div className="mx-auto max-w-2xl px-4 pb-20 pt-8 text-center sm:px-6">
        <p className="font-semibold">Missing event.</p>
      </div>
    );
  }

  const event = await prisma.event.findUnique({ where: { id: eventId }, select: { title: true } });
  if (!event) {
    return (
      <div className="mx-auto max-w-2xl px-4 pb-20 pt-8 text-center sm:px-6">
        <p className="font-semibold">Event not found.</p>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-2xl px-4 pb-20 pt-8 sm:px-6">
      <h1 className="mb-1 text-2xl font-bold">Contact organizer</h1>
      <p className="mb-6 text-sm text-muted">About {event.title}</p>

      <form
        action={async (formData) => {
          "use server";
          await createTicket(eventId, formData);
        }}
        className="card space-y-4 p-6"
      >
        <div>
          <label className="label" htmlFor="subject">Subject</label>
          <input id="subject" name="subject" className="input" required maxLength={200} />
        </div>
        <div>
          <label className="label" htmlFor="body">Message</label>
          <textarea id="body" name="body" className="input min-h-32" required />
        </div>
        <button type="submit" className="btn-primary w-full">Send</button>
      </form>
    </div>
  );
}
