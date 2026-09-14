import { describe, expect, it } from "vitest";
import { attendanceBySessionByHour, peakAttendanceHour, exhibitorLeadTotals } from "@/lib/conference-analytics";

describe("attendanceBySessionByHour", () => {
  it("buckets attendance taps by session and by hour, zero-filled across a shared hour range", () => {
    const rangeStart = new Date("2026-06-01T09:00:00");
    const sessions = [
      { id: "s1", name: "Keynote" },
      { id: "s2", name: "Workshop" },
    ];
    const attendances = [
      { eventSessionId: "s1", recordedAt: new Date("2026-06-01T09:15:00") },
      { eventSessionId: "s1", recordedAt: new Date("2026-06-01T09:45:00") },
      { eventSessionId: "s2", recordedAt: new Date("2026-06-01T10:05:00") },
    ];
    const now = new Date("2026-06-01T10:30:00");

    const grid = attendanceBySessionByHour(attendances, sessions, rangeStart, now);
    expect(grid).toHaveLength(2);

    const keynote = grid.find((r) => r.sessionId === "s1")!;
    expect(keynote.hours.map((h) => h.hour)).toEqual(["09:00", "10:00"]);
    expect(keynote.hours[0].count).toBe(2);
    expect(keynote.hours[1].count).toBe(0); // zero-filled, not omitted

    const workshop = grid.find((r) => r.sessionId === "s2")!;
    expect(workshop.hours[0].count).toBe(0);
    expect(workshop.hours[1].count).toBe(1);
  });

  it("returns an all-zero grid for a session with no attendance yet", () => {
    const grid = attendanceBySessionByHour([], [{ id: "s1", name: "Empty Room" }], new Date("2026-06-01T09:00:00"), new Date("2026-06-01T09:00:00"));
    expect(grid).toEqual([{ sessionId: "s1", sessionName: "Empty Room", hours: [{ hour: "09:00", count: 0 }] }]);
  });
});

describe("peakAttendanceHour", () => {
  it("identifies the hour with the highest total attendance across every session", () => {
    const attendances = [
      { recordedAt: new Date("2026-06-01T09:10:00") },
      { recordedAt: new Date("2026-06-01T10:00:00") },
      { recordedAt: new Date("2026-06-01T10:20:00") },
      { recordedAt: new Date("2026-06-01T10:40:00") },
    ];
    const peak = peakAttendanceHour(attendances);
    expect(peak).toEqual({ hour: "10:00", count: 3 });
  });

  it("is null when there's no attendance data at all", () => {
    expect(peakAttendanceHour([])).toBeNull();
  });
});

describe("exhibitorLeadTotals", () => {
  it("ranks vendors by lead count, most leads first", () => {
    const leads = [
      { vendor: { id: "v1", name: "Acme" } },
      { vendor: { id: "v2", name: "Globex" } },
      { vendor: { id: "v1", name: "Acme" } },
      { vendor: { id: "v1", name: "Acme" } },
    ];
    expect(exhibitorLeadTotals(leads)).toEqual([
      { label: "Acme", value: 3 },
      { label: "Globex", value: 1 },
    ]);
  });

  it("is an empty array when there are no leads", () => {
    expect(exhibitorLeadTotals([])).toEqual([]);
  });

  it("respects the limit parameter", () => {
    const leads = Array.from({ length: 15 }, (_, i) => ({ vendor: { id: `v${i}`, name: `Vendor ${i}` } }));
    expect(exhibitorLeadTotals(leads, 3)).toHaveLength(3);
  });
});
