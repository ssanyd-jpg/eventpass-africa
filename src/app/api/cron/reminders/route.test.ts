import { describe, expect, it, vi, afterEach } from "vitest";

// Pure unit test of the auth gate — sendEventReminders itself is covered by
// src/lib/reminders.test.ts against the real test database, so it's mocked
// here rather than re-exercised. vi.hoisted() so the mock fn is initialized
// before vi.mock's hoisted factory runs — see whatsapp.test.ts's comment.
const { mockSendEventReminders } = vi.hoisted(() => ({ mockSendEventReminders: vi.fn() }));
vi.mock("@/lib/reminders", () => ({
  sendEventReminders: mockSendEventReminders,
}));

import { GET } from "@/app/api/cron/reminders/route";

describe("GET /api/cron/reminders", () => {
  const originalSecret = process.env.CRON_SECRET;

  afterEach(() => {
    if (originalSecret === undefined) delete process.env.CRON_SECRET;
    else process.env.CRON_SECRET = originalSecret;
    mockSendEventReminders.mockReset();
  });

  it("rejects a request with no Authorization header", async () => {
    process.env.CRON_SECRET = "test-secret";
    const response = await GET(new Request("http://localhost/api/cron/reminders"));
    expect(response.status).toBe(401);
    expect(mockSendEventReminders).not.toHaveBeenCalled();
  });

  it("rejects a request with the wrong bearer token", async () => {
    process.env.CRON_SECRET = "test-secret";
    const response = await GET(
      new Request("http://localhost/api/cron/reminders", { headers: { authorization: "Bearer wrong-token" } })
    );
    expect(response.status).toBe(401);
    expect(mockSendEventReminders).not.toHaveBeenCalled();
  });

  it("rejects every request when CRON_SECRET isn't configured, even with a header present", async () => {
    delete process.env.CRON_SECRET;
    const response = await GET(
      new Request("http://localhost/api/cron/reminders", { headers: { authorization: "Bearer undefined" } })
    );
    expect(response.status).toBe(401);
    expect(mockSendEventReminders).not.toHaveBeenCalled();
  });

  it("runs the reminder job when the bearer token matches CRON_SECRET", async () => {
    process.env.CRON_SECRET = "test-secret";
    mockSendEventReminders.mockResolvedValue({ ok: true, eventsChecked: 2, remindersSent: 3 });

    const response = await GET(
      new Request("http://localhost/api/cron/reminders", { headers: { authorization: "Bearer test-secret" } })
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, eventsChecked: 2, remindersSent: 3 });
    expect(mockSendEventReminders).toHaveBeenCalledTimes(1);
  });
});
