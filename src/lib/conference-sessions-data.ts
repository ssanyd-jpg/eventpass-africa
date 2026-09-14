import { prisma } from "@/lib/prisma";
import {
  attendanceBySessionByHour,
  peakAttendanceHour,
  exhibitorLeadTotals,
  type SessionHourlyStats,
  type PeakHourStat,
  type RankedEntry,
} from "@/lib/conference-analytics";

// Split out of the route handler so it's directly testable without going
// through auth() — same reasoning getTimingDashboardData/
// getVendorDashboardData are split from their own routes.

export interface ConferenceAnalyticsData {
  eventId: string;
  eventTitle: string;
  sessions: {
    id: string;
    name: string;
    speaker: string | null;
    location: string | null;
    startsAt: string;
    endsAt: string;
    attendanceCount: number;
  }[];
  totalAttendance: number;
  totalLeads: number;
  heatmap: SessionHourlyStats[];
  peakHour: PeakHourStat | null;
  exhibitorLeadTotals: RankedEntry[];
}

export async function getConferenceAnalyticsData(eventId: string): Promise<ConferenceAnalyticsData | null> {
  const event = await prisma.event.findUnique({
    where: { id: eventId },
    select: { id: true, title: true, startsAt: true },
  });
  if (!event) return null;

  const sessions = await prisma.conferenceSession.findMany({
    where: { eventId },
    include: { _count: { select: { attendances: true } } },
    orderBy: { startsAt: "asc" },
  });

  const attendances = await prisma.sessionAttendance.findMany({
    where: { eventId },
    select: { eventSessionId: true, recordedAt: true },
  });

  const leads = await prisma.exhibitorLead.findMany({
    where: { eventId },
    include: { vendor: { select: { id: true, name: true } } },
  });

  return {
    eventId: event.id,
    eventTitle: event.title,
    sessions: sessions.map((s) => ({
      id: s.id,
      name: s.name,
      speaker: s.speaker,
      location: s.location,
      startsAt: s.startsAt.toISOString(),
      endsAt: s.endsAt.toISOString(),
      attendanceCount: s._count.attendances,
    })),
    totalAttendance: attendances.length,
    totalLeads: leads.length,
    heatmap: attendanceBySessionByHour(attendances, sessions, event.startsAt),
    peakHour: peakAttendanceHour(attendances),
    exhibitorLeadTotals: exhibitorLeadTotals(leads),
  };
}
