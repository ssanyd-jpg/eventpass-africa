import { describe, expect, it, vi, afterEach } from "vitest";

// Pure unit test of the auth gate — sendEventReminders itself is covered by
// src/lib/reminders.test.ts against the real test database, so it's mocked
// here rather than re-exercised. vi.hoisted() so the mock fn is initialized
// before vi.mock's hoisted factory runs — see whatsapp.test.ts's comment.
const {
  mockSendEventReminders,
  mockRunPendingTopupSweep,
  mockRunSeasonRenewalSweep,
  mockRunWhatsappGroupArchiveSweep,
  mockRunWaitlistClosureSweep,
} = vi.hoisted(() => ({
  mockSendEventReminders: vi.fn(),
  mockRunPendingTopupSweep: vi.fn(),
  mockRunSeasonRenewalSweep: vi.fn(),
  mockRunWhatsappGroupArchiveSweep: vi.fn(),
  mockRunWaitlistClosureSweep: vi.fn(),
}));
vi.mock("@/lib/reminders", () => ({
  sendEventReminders: mockSendEventReminders,
}));
// Session 35 — the pending top-up sweep rides on this route (both Hobby cron
// slots are taken); its own behavior is covered by src/lib/pending-topups.test.ts.
vi.mock("@/lib/pending-topups", () => ({
  runPendingTopupSweep: mockRunPendingTopupSweep,
}));
// Season pass auto-renewal sweep rides on this same route — same reasoning,
// its own behavior is covered by src/lib/season-renewal.test.ts.
vi.mock("@/lib/season-renewal", () => ({
  runSeasonRenewalSweep: mockRunSeasonRenewalSweep,
}));
// Event WhatsApp group archive sweep — same reasoning, its own behavior is
// covered by src/lib/whatsapp-group.test.ts.
vi.mock("@/lib/whatsapp-group", () => ({
  runWhatsappGroupArchiveSweep: mockRunWhatsappGroupArchiveSweep,
}));
// Waitlist closure sweep — same reasoning, its own behavior is covered by
// src/lib/waitlist.test.ts.
vi.mock("@/lib/waitlist", () => ({
  runWaitlistClosureSweep: mockRunWaitlistClosureSweep,
}));

import { GET } from "@/app/api/cron/reminders/route";

describe("GET /api/cron/reminders", () => {
  const originalSecret = process.env.CRON_SECRET;

  afterEach(() => {
    if (originalSecret === undefined) delete process.env.CRON_SECRET;
    else process.env.CRON_SECRET = originalSecret;
    mockSendEventReminders.mockReset();
    mockRunPendingTopupSweep.mockReset();
    mockRunSeasonRenewalSweep.mockReset();
    mockRunWhatsappGroupArchiveSweep.mockReset();
    mockRunWaitlistClosureSweep.mockReset();
  });

  it("rejects a request with no Authorization header", async () => {
    process.env.CRON_SECRET = "test-secret";
    const response = await GET(new Request("http://localhost/api/cron/reminders"));
    expect(response.status).toBe(401);
    expect(mockSendEventReminders).not.toHaveBeenCalled();
    expect(mockRunPendingTopupSweep).not.toHaveBeenCalled();
    expect(mockRunSeasonRenewalSweep).not.toHaveBeenCalled();
    expect(mockRunWhatsappGroupArchiveSweep).not.toHaveBeenCalled();
    expect(mockRunWaitlistClosureSweep).not.toHaveBeenCalled();
  });

  it("rejects a request with the wrong bearer token", async () => {
    process.env.CRON_SECRET = "test-secret";
    const response = await GET(
      new Request("http://localhost/api/cron/reminders", { headers: { authorization: "Bearer wrong-token" } })
    );
    expect(response.status).toBe(401);
    expect(mockSendEventReminders).not.toHaveBeenCalled();
    expect(mockRunPendingTopupSweep).not.toHaveBeenCalled();
    expect(mockRunSeasonRenewalSweep).not.toHaveBeenCalled();
    expect(mockRunWhatsappGroupArchiveSweep).not.toHaveBeenCalled();
    expect(mockRunWaitlistClosureSweep).not.toHaveBeenCalled();
  });

  it("rejects every request when CRON_SECRET isn't configured, even with a header present", async () => {
    delete process.env.CRON_SECRET;
    const response = await GET(
      new Request("http://localhost/api/cron/reminders", { headers: { authorization: "Bearer undefined" } })
    );
    expect(response.status).toBe(401);
    expect(mockSendEventReminders).not.toHaveBeenCalled();
    expect(mockRunPendingTopupSweep).not.toHaveBeenCalled();
    expect(mockRunSeasonRenewalSweep).not.toHaveBeenCalled();
    expect(mockRunWhatsappGroupArchiveSweep).not.toHaveBeenCalled();
    expect(mockRunWaitlistClosureSweep).not.toHaveBeenCalled();
  });

  it("runs the reminder job, the pending top-up sweep, the season renewal sweep, the whatsapp group archive sweep, and the waitlist closure sweep when the bearer token matches CRON_SECRET", async () => {
    process.env.CRON_SECRET = "test-secret";
    mockSendEventReminders.mockResolvedValue({ ok: true, eventsChecked: 2, remindersSent: 3 });
    const sweep = { ok: true, processed: 4, confirmed: 2, failed: 1, stillPending: 1, alreadyResolved: 0 };
    mockRunPendingTopupSweep.mockResolvedValue(sweep);
    const seasonRenewal = { offersSent: 2, skipped: 0 };
    mockRunSeasonRenewalSweep.mockResolvedValue(seasonRenewal);
    const whatsappGroupArchive = { ok: true, eventsChecked: 1, archivedCount: 1 };
    mockRunWhatsappGroupArchiveSweep.mockResolvedValue(whatsappGroupArchive);
    const waitlistClosure = { ok: true, eventsChecked: 1, notifiedCount: 2 };
    mockRunWaitlistClosureSweep.mockResolvedValue(waitlistClosure);

    const response = await GET(
      new Request("http://localhost/api/cron/reminders", { headers: { authorization: "Bearer test-secret" } })
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      ok: true,
      eventsChecked: 2,
      remindersSent: 3,
      pendingTopups: sweep,
      seasonRenewal,
      whatsappGroupArchive,
      waitlistClosure,
    });
    expect(mockSendEventReminders).toHaveBeenCalledTimes(1);
    expect(mockRunPendingTopupSweep).toHaveBeenCalledTimes(1);
    expect(mockRunSeasonRenewalSweep).toHaveBeenCalledTimes(1);
    expect(mockRunWhatsappGroupArchiveSweep).toHaveBeenCalledTimes(1);
    expect(mockRunWaitlistClosureSweep).toHaveBeenCalledTimes(1);
  });

  it("still returns the reminders result when the top-up sweep throws", async () => {
    process.env.CRON_SECRET = "test-secret";
    mockSendEventReminders.mockResolvedValue({ ok: true, eventsChecked: 1, remindersSent: 1 });
    mockRunPendingTopupSweep.mockRejectedValue(new Error("neon down"));
    mockRunSeasonRenewalSweep.mockResolvedValue({ offersSent: 0, skipped: 0 });
    mockRunWhatsappGroupArchiveSweep.mockResolvedValue({ ok: true, eventsChecked: 0, archivedCount: 0 });
    mockRunWaitlistClosureSweep.mockResolvedValue({ ok: true, eventsChecked: 0, notifiedCount: 0 });
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const response = await GET(
      new Request("http://localhost/api/cron/reminders", { headers: { authorization: "Bearer test-secret" } })
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      ok: true,
      eventsChecked: 1,
      remindersSent: 1,
      pendingTopups: { ok: false, reason: "SWEEP_FAILED" },
      seasonRenewal: { offersSent: 0, skipped: 0 },
      whatsappGroupArchive: { ok: true, eventsChecked: 0, archivedCount: 0 },
      waitlistClosure: { ok: true, eventsChecked: 0, notifiedCount: 0 },
    });
    errorSpy.mockRestore();
  });

  it("still returns the reminders result when the whatsapp group archive sweep throws", async () => {
    process.env.CRON_SECRET = "test-secret";
    mockSendEventReminders.mockResolvedValue({ ok: true, eventsChecked: 1, remindersSent: 1 });
    mockRunPendingTopupSweep.mockResolvedValue({ ok: true, processed: 0, confirmed: 0, failed: 0, stillPending: 0, alreadyResolved: 0 });
    mockRunSeasonRenewalSweep.mockResolvedValue({ offersSent: 0, skipped: 0 });
    mockRunWhatsappGroupArchiveSweep.mockRejectedValue(new Error("neon down"));
    mockRunWaitlistClosureSweep.mockResolvedValue({ ok: true, eventsChecked: 0, notifiedCount: 0 });
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const response = await GET(
      new Request("http://localhost/api/cron/reminders", { headers: { authorization: "Bearer test-secret" } })
    );

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.whatsappGroupArchive).toEqual({ ok: false, reason: "SWEEP_FAILED" });
    errorSpy.mockRestore();
  });

  it("still returns the reminders result when the season renewal sweep throws", async () => {
    process.env.CRON_SECRET = "test-secret";
    mockSendEventReminders.mockResolvedValue({ ok: true, eventsChecked: 1, remindersSent: 1 });
    mockRunPendingTopupSweep.mockResolvedValue({ ok: true, processed: 0, confirmed: 0, failed: 0, stillPending: 0, alreadyResolved: 0 });
    mockRunSeasonRenewalSweep.mockRejectedValue(new Error("neon down"));
    mockRunWhatsappGroupArchiveSweep.mockResolvedValue({ ok: true, eventsChecked: 0, archivedCount: 0 });
    mockRunWaitlistClosureSweep.mockResolvedValue({ ok: true, eventsChecked: 0, notifiedCount: 0 });
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const response = await GET(
      new Request("http://localhost/api/cron/reminders", { headers: { authorization: "Bearer test-secret" } })
    );

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.seasonRenewal).toEqual({ ok: false, reason: "SWEEP_FAILED" });
    errorSpy.mockRestore();
  });

  it("still returns the reminders result when the waitlist closure sweep throws", async () => {
    process.env.CRON_SECRET = "test-secret";
    mockSendEventReminders.mockResolvedValue({ ok: true, eventsChecked: 1, remindersSent: 1 });
    mockRunPendingTopupSweep.mockResolvedValue({ ok: true, processed: 0, confirmed: 0, failed: 0, stillPending: 0, alreadyResolved: 0 });
    mockRunSeasonRenewalSweep.mockResolvedValue({ offersSent: 0, skipped: 0 });
    mockRunWhatsappGroupArchiveSweep.mockResolvedValue({ ok: true, eventsChecked: 0, archivedCount: 0 });
    mockRunWaitlistClosureSweep.mockRejectedValue(new Error("neon down"));
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const response = await GET(
      new Request("http://localhost/api/cron/reminders", { headers: { authorization: "Bearer test-secret" } })
    );

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.waitlistClosure).toEqual({ ok: false, reason: "SWEEP_FAILED" });
    errorSpy.mockRestore();
  });

  it("still runs the top-up sweep, the season renewal sweep, the whatsapp group archive sweep, and the waitlist closure sweep when the reminders job throws", async () => {
    process.env.CRON_SECRET = "test-secret";
    mockSendEventReminders.mockRejectedValue(new Error("whatsapp down"));
    mockRunPendingTopupSweep.mockResolvedValue({
      ok: true,
      processed: 0,
      confirmed: 0,
      failed: 0,
      stillPending: 0,
      alreadyResolved: 0,
    });
    mockRunSeasonRenewalSweep.mockResolvedValue({ offersSent: 0, skipped: 0 });
    mockRunWhatsappGroupArchiveSweep.mockResolvedValue({ ok: true, eventsChecked: 0, archivedCount: 0 });
    mockRunWaitlistClosureSweep.mockResolvedValue({ ok: true, eventsChecked: 0, notifiedCount: 0 });

    await expect(
      GET(new Request("http://localhost/api/cron/reminders", { headers: { authorization: "Bearer test-secret" } }))
    ).rejects.toThrow("whatsapp down");
    expect(mockRunPendingTopupSweep).toHaveBeenCalledTimes(1);
    expect(mockRunSeasonRenewalSweep).toHaveBeenCalledTimes(1);
    expect(mockRunWhatsappGroupArchiveSweep).toHaveBeenCalledTimes(1);
    expect(mockRunWaitlistClosureSweep).toHaveBeenCalledTimes(1);
  });
});
