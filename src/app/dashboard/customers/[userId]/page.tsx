import { redirect } from "next/navigation";
import Link from "next/link";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { formatCents, formatDateTime } from "@/lib/format";
import { getCustomerDetailData } from "@/lib/analytics-data";
import { addNote, replaceTicketCode, replaceWalletCode } from "../actions";

const STATUS_STYLE: Record<string, string> = {
  PAID: "border-ok/40 bg-ok/10 text-ok",
  NEEDS_REVIEW: "border-danger/40 bg-danger/10 text-danger",
  REFUNDED: "border-warn/40 bg-warn/10 text-warn",
};

export default async function CustomerDetailPage({ params }: { params: { userId: string } }) {
  const session = await auth();
  if (!session?.user?.id) {
    redirect(`/login?callbackUrl=/dashboard/customers/${params.userId}`);
  }
  if (session.user.organizationRole === "GATE_CREW") {
    redirect("/dashboard");
  }

  const { customer, orders, wallets } = await getCustomerDetailData(session.user.organizationId, params.userId);

  if (!customer) {
    return (
      <div className="mx-auto max-w-2xl px-4 pb-20 pt-8 text-center sm:px-6">
        <Link href="/dashboard/customers" className="text-sm text-muted hover:text-foreground">← Customers</Link>
        <p className="mt-10 font-semibold">This person isn&apos;t a customer of your organization.</p>
      </div>
    );
  }

  const notes = await prisma.customerNote.findMany({
    where: { organizationId: session.user.organizationId, customerUserId: params.userId },
    orderBy: { createdAt: "desc" },
  });

  return (
    <div className="mx-auto max-w-2xl px-4 pb-20 pt-8 sm:px-6">
      <Link href="/dashboard/customers" className="text-sm text-muted hover:text-foreground">← Customers</Link>
      <h1 className="mb-1 mt-3 text-2xl font-bold">{customer.name}</h1>
      <p className="mb-6 text-sm text-muted">{customer.email}</p>

      <h2 className="mb-3 font-semibold">Order history</h2>
      <div className="card mb-8 divide-y divide-border">
        {orders.map((o) => (
          <div key={o.id} className="space-y-3 p-4 text-sm">
            <div className="flex items-center justify-between gap-3">
              <div>
                <p className="font-medium">{o.event.title}</p>
                <p className="text-xs text-muted">{formatDateTime(o.createdAt)}</p>
              </div>
              <div className="flex items-center gap-3">
                <span className="font-medium">{formatCents(o.totalCents, o.currency)}</span>
                <span className={`pill ${STATUS_STYLE[o.status] ?? ""}`}>{o.status}</span>
              </div>
            </div>
            {o.tickets.length > 0 && (
              <div className="space-y-2 border-t border-border pt-3">
                {o.tickets.map((t) => (
                  <div key={t.id} className="flex items-center justify-between gap-3 text-xs">
                    <div>
                      <span className="font-mono">{t.code}</span>
                      <span className="ml-2 text-muted">{t.checkedIn ? "Checked in" : "Not checked in"}</span>
                    </div>
                    <form
                      action={async () => {
                        "use server";
                        await replaceTicketCode(t.id);
                      }}
                    >
                      <button type="submit" className="font-medium text-danger hover:underline">
                        Mark lost & issue new code
                      </button>
                    </form>
                  </div>
                ))}
              </div>
            )}
          </div>
        ))}
        {orders.length === 0 && <p className="p-6 text-center text-muted">No orders yet.</p>}
      </div>

      <h2 className="mb-3 font-semibold">Wallets</h2>
      <div className="card mb-8 divide-y divide-border">
        {wallets.map((w) => (
          <div key={w.id} className="flex items-center justify-between gap-3 p-4 text-sm">
            <div>
              <p className="font-mono font-medium">{w.code}</p>
              <p className="text-xs text-muted">{w.event.title} · {formatCents(w.balanceCents, w.currency)}</p>
            </div>
            <form
              action={async () => {
                "use server";
                await replaceWalletCode(w.id);
              }}
            >
              <button type="submit" className="text-xs font-medium text-danger hover:underline">
                Mark lost & issue new code
              </button>
            </form>
          </div>
        ))}
        {wallets.length === 0 && <p className="p-6 text-center text-sm text-muted">No wallets yet.</p>}
      </div>

      <h2 className="mb-3 font-semibold">Notes</h2>
      <form
        action={async (formData) => {
          "use server";
          await addNote(params.userId, formData);
        }}
        className="card mb-4 space-y-3 p-4"
      >
        <textarea
          name="body"
          className="input min-h-20"
          placeholder="Add a note about this customer…"
          required
        />
        <button type="submit" className="btn-primary text-sm">Add note</button>
      </form>

      {notes.length === 0 ? (
        <div className="card p-6 text-center text-sm text-muted">No notes yet.</div>
      ) : (
        <div className="card divide-y divide-border">
          {notes.map((n) => (
            <div key={n.id} className="p-4 text-sm">
              <p>{n.body}</p>
              <p className="mt-1 text-xs text-muted">{n.authorName} · {formatDateTime(n.createdAt)}</p>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
