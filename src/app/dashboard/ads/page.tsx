import { redirect } from "next/navigation";
import Link from "next/link";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import {
  getFeaturedSlotAvailability,
  getFeaturedListingHistory,
  getBroadcastHistory,
  FEATURED_LISTING_PRICING,
  BROADCAST_PRICE_PER_RECIPIENT_CENTS,
  BROADCAST_MIN_AMOUNT_CENTS,
  BROADCAST_MESSAGE_MAX_LENGTH,
} from "@/lib/chaap-ads";
import AdsDashboard from "./AdsDashboard";

// Server-rendered, non-offline — same "org-wide settings, low-frequency"
// posture as dashboard/loyalty/page.tsx, which this mirrors.
export default async function AdsDashboardPage() {
  const session = await auth();
  if (!session?.user?.id) {
    redirect("/login?callbackUrl=/dashboard/ads");
  }
  if (session.user.organizationRole === "GATE_CREW") {
    redirect("/dashboard");
  }

  const [events, slotAvailability, listingHistory, broadcastHistory] = await Promise.all([
    prisma.event.findMany({
      where: { organizationId: session.user.organizationId, status: "LIVE" },
      select: { id: true, title: true },
      orderBy: { startsAt: "asc" },
    }),
    getFeaturedSlotAvailability(),
    getFeaturedListingHistory(session.user.organizationId),
    getBroadcastHistory(session.user.organizationId),
  ]);

  return (
    <div className="mx-auto max-w-4xl px-4 pb-20 pt-8 sm:px-6">
      <Link href="/dashboard" className="text-sm text-muted hover:text-foreground">← Dashboard</Link>
      <div className="mt-3">
        <h1 className="text-2xl font-bold">Chaap Ads</h1>
        <p className="text-sm text-muted">
          Pay to get your event seen on the Chaap marketplace, or reach past attendees directly by WhatsApp.
        </p>
      </div>

      <AdsDashboard
        events={events}
        slotAvailability={slotAvailability}
        pricing={FEATURED_LISTING_PRICING}
        listingHistory={listingHistory}
        broadcastHistory={broadcastHistory}
        broadcastPricing={{
          perRecipientCents: BROADCAST_PRICE_PER_RECIPIENT_CENTS,
          minAmountCents: BROADCAST_MIN_AMOUNT_CENTS,
          messageMaxLength: BROADCAST_MESSAGE_MAX_LENGTH,
        }}
      />
    </div>
  );
}
