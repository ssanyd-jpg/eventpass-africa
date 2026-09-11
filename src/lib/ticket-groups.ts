// Session 13 — pure, DB-free group-ticketing calculations, mirroring
// carry-over.ts's own convention of a feature-specific summarizer living
// outside analytics.ts proper (see analytics/page.tsx, which already
// imports summarizeCarryOverVolume the same way). Fed plain rows already
// fetched by analytics-data.ts, never touches Prisma itself.

export interface GroupTicketingRawRow {
  ticketCount: number;
}

export interface GroupTicketingSummary {
  groupCount: number;
  totalGroupTickets: number;
  averageGroupSize: number | null;
}

export function summarizeGroupSales(groups: GroupTicketingRawRow[]): GroupTicketingSummary {
  const groupCount = groups.length;
  const totalGroupTickets = groups.reduce((sum, g) => sum + g.ticketCount, 0);
  return {
    groupCount,
    totalGroupTickets,
    averageGroupSize: groupCount === 0 ? null : Math.round((totalGroupTickets / groupCount) * 10) / 10,
  };
}
