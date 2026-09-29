import { notFound } from "next/navigation";
import { auth } from "@/auth";
import { formatCents, formatDate } from "@/lib/format";
import { getPublicSeasonPass } from "@/lib/season-pass";
import PurchaseForm from "./PurchaseForm";

// Public, unauthenticated view (mirrors the resale marketplace page) —
// buying itself requires an account, browsing doesn't. Mobile-first: this
// is the page a fan lands on from a club's social post or a WhatsApp share.
export default async function SeasonPassPurchasePage({ params }: { params: { id: string } }) {
  const pass = await getPublicSeasonPass(params.id);
  if (!pass) notFound();

  const session = await auth();

  return (
    <div className="mx-auto max-w-lg px-4 pb-20 pt-8 sm:px-6">
      <p className="text-sm font-medium text-muted">{pass.clubName}</p>
      <h1 className="mt-1 text-2xl font-bold">{pass.name}</h1>
      {pass.description && <p className="mt-2 text-sm text-muted">{pass.description}</p>}

      <div className="card mt-6 p-5">
        <p className="text-3xl font-bold">{formatCents(pass.price, pass.currency)}</p>
        <p className="text-sm text-muted">Valid {formatDate(pass.startDate)} – {formatDate(pass.endDate)}</p>
      </div>

      {pass.events.length > 0 && (
        <>
          <h2 className="mb-2 mt-6 font-semibold">Included matches</h2>
          <ul className="card divide-y divide-border text-sm">
            {pass.events.map((e, i) => (
              <li key={i} className="p-3">
                <span className="font-medium">{e.title}</span>
                <span className="ml-2 text-muted">{formatDate(e.startsAt)}</span>
              </li>
            ))}
          </ul>
        </>
      )}

      <div className="mt-6">
        <PurchaseForm seasonPassId={pass.id} price={pass.price} currency={pass.currency} purchasable={pass.purchasable} signedIn={!!session?.user?.id} />
      </div>
    </div>
  );
}
