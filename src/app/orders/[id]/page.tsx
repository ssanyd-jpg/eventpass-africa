"use client";

import { useLiveQuery } from "dexie-react-hooks";
import { useParams } from "next/navigation";
import Link from "next/link";
import { db } from "@/lib/db";
import OrderConfirmation from "@/components/OrderConfirmation";

export default function OrderConfirmationPage() {
  const { id: rawId } = useParams<{ id: string }>();
  const id = decodeURIComponent(rawId);
  const order = useLiveQuery(async () => {
    const byId = await db.orders.get(id);
    return byId ?? (await db.orders.where("clientId").equals(id).first()) ?? null;
  }, [id]);

  if (order === undefined) {
    return <div className="mx-auto max-w-2xl px-4 py-16 text-center text-muted">Loading…</div>;
  }

  if (!order) {
    return (
      <div className="mx-auto max-w-2xl px-4 py-16 text-center">
        <p className="text-lg font-semibold">Order not found on this device.</p>
        <Link href="/account/tickets" className="btn-secondary mt-6 inline-flex">My Tickets</Link>
      </div>
    );
  }

  return <OrderConfirmation order={order} />;
}
