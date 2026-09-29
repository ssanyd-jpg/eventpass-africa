import { notFound } from "next/navigation";
import { formatCents, formatDate } from "@/lib/format";
import { getRenewalOfferStatus } from "@/lib/season-renewal";
import RenewalActions from "./RenewalActions";

// Public, no login required — the token itself is the credential (see
// season-renewal.ts). Mobile-first: this is opened straight from the
// renewal offer's WhatsApp message on a phone.
export default async function RenewalPage({ params }: { params: { token: string } }) {
  const status = await getRenewalOfferStatus(params.token);
  if (!status) notFound();

  return (
    <div className="mx-auto flex min-h-[70vh] max-w-sm flex-col justify-center px-5 py-10">
      <p className="text-center text-sm font-medium text-muted">{status.clubName}</p>
      <h1 className="mt-1 text-center text-2xl font-bold">{status.seasonPassName}</h1>

      {status.state === "OFFERED" && (
        <>
          <div className="card mt-6 space-y-1 p-5 text-center">
            <p className="text-3xl font-bold">{formatCents(status.price, status.currency)}</p>
            <p className="text-sm text-muted">Current pass expires {formatDate(status.endDate)}</p>
          </div>
          <div className="mt-6">
            <RenewalActions token={params.token} price={status.price} currency={status.currency} />
          </div>
        </>
      )}

      {status.state === "EXPIRED" && (
        <div className="card mt-6 p-5 text-center">
          <p className="font-semibold">This renewal link has expired.</p>
          <p className="mt-2 text-sm text-muted">Contact your club to renew manually.</p>
        </div>
      )}

      {status.state === "ALREADY_RENEWED" && (
        <div className="card mt-6 p-5 text-center">
          <p className="font-semibold">Your season pass is already renewed. See you at the next match! ✅</p>
        </div>
      )}

      {status.state === "ALREADY_DECLINED" && (
        <div className="card mt-6 p-5 text-center">
          <p className="font-semibold">You&apos;ve already declined this renewal offer.</p>
          <p className="mt-2 text-sm text-muted">You can always renew manually at chaap.africa.</p>
        </div>
      )}

      {status.state === "NOT_FOUND" && (
        <div className="card mt-6 p-5 text-center">
          <p className="font-semibold">This renewal offer is no longer available.</p>
        </div>
      )}
    </div>
  );
}
