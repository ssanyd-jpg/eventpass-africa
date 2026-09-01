import { prisma } from "@/lib/prisma";
import { buildCsvDocument } from "@/lib/csv";

// Business logic behind the sponsor-leads dashboard page and its CSV
// export, extracted for direct testability — same reasoning as
// sync-handlers.ts's own header comment.

// Scoped by organizationId (via sponsor -> event -> organization), not just
// sponsorId, so one organizer can never fetch another org's sponsor leads
// by guessing an id — same discipline as every other dashboard detail
// query in this codebase (see src/app/dashboard/customers/[userId]/page.tsx).
export async function getSponsor(organizationId: string, sponsorId: string) {
  return prisma.sponsor.findFirst({
    where: { id: sponsorId, event: { organizationId } },
  });
}

export async function getSponsorLeads(sponsorId: string) {
  return prisma.walletTransaction.findMany({
    where: { sponsorId, type: "SPONSOR_TAP" },
    orderBy: { createdAt: "desc" },
    include: {
      wallet: { include: { owner: { select: { name: true, email: true } } } },
      campaign: { select: { name: true } },
    },
  });
}

export type SponsorLead = Awaited<ReturnType<typeof getSponsorLeads>>[number];

// Doubles as the de facto campaign-redemptions report — a non-blank
// Campaign column marks a redemption, not just a plain lead-capture tap.
// No separate export/report route for v1; the data already lives on the
// same rows this CSV already reads.
export function buildSponsorLeadsCsv(sponsorName: string, leads: SponsorLead[]): string {
  return buildCsvDocument([
    {
      title: `Sponsor leads — ${sponsorName}`,
      headers: ["Name", "Email", "Note", "Campaign", "Scanned At"],
      rows: leads.map((l) => [
        l.wallet.owner.name,
        l.wallet.owner.email,
        l.note ?? "",
        l.campaign?.name ?? "",
        l.createdAt.toISOString(),
      ]),
    },
  ]);
}
