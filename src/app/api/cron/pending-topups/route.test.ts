import { describe, expect, it, vi, afterEach } from "vitest";

// Pure unit test of the auth gate, same shape as the reminders route test —
// runPendingTopupSweep itself is covered against the real test database in
// src/lib/pending-topups.test.ts.
const { mockRunPendingTopupSweep } = vi.hoisted(() => ({ mockRunPendingTopupSweep: vi.fn() }));
vi.mock("@/lib/pending-topups", () => ({
  runPendingTopupSweep: mockRunPendingTopupSweep,
}));

import { GET } from "@/app/api/cron/pending-topups/route";

describe("GET /api/cron/pending-topups", () => {
  const originalSecret = process.env.CRON_SECRET;

  afterEach(() => {
    if (originalSecret === undefined) delete process.env.CRON_SECRET;
    else process.env.CRON_SECRET = originalSecret;
    mockRunPendingTopupSweep.mockReset();
  });

  it("rejects a request with no Authorization header", async () => {
    process.env.CRON_SECRET = "test-secret";
    const response = await GET(new Request("http://localhost/api/cron/pending-topups"));
    expect(response.status).toBe(401);
    expect(mockRunPendingTopupSweep).not.toHaveBeenCalled();
  });

  it("rejects a request with the wrong bearer token", async () => {
    process.env.CRON_SECRET = "test-secret";
    const response = await GET(
      new Request("http://localhost/api/cron/pending-topups", { headers: { authorization: "Bearer wrong-token" } })
    );
    expect(response.status).toBe(401);
    expect(mockRunPendingTopupSweep).not.toHaveBeenCalled();
  });

  it("rejects every request when CRON_SECRET isn't configured, even with a header present", async () => {
    delete process.env.CRON_SECRET;
    const response = await GET(
      new Request("http://localhost/api/cron/pending-topups", { headers: { authorization: "Bearer undefined" } })
    );
    expect(response.status).toBe(401);
    expect(mockRunPendingTopupSweep).not.toHaveBeenCalled();
  });

  it("runs the sweep and returns its counts when the bearer token matches", async () => {
    process.env.CRON_SECRET = "test-secret";
    const sweep = { ok: true, processed: 3, confirmed: 1, failed: 1, stillPending: 1, alreadyResolved: 0 };
    mockRunPendingTopupSweep.mockResolvedValue(sweep);

    const response = await GET(
      new Request("http://localhost/api/cron/pending-topups", { headers: { authorization: "Bearer test-secret" } })
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(sweep);
    expect(mockRunPendingTopupSweep).toHaveBeenCalledTimes(1);
  });
});
