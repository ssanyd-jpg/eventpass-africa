import { describe, expect, it } from "vitest";
import { GET } from "./route";

describe("GET /api/tickets/[code]/qr.png", () => {
  it("returns a PNG image for a valid ticket code", async () => {
    const res = await GET(new Request("http://localhost/api/tickets/FREE-00001/qr.png"), {
      params: { ticketId: "FREE-00001" },
    });

    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("image/png");
    expect(res.headers.get("Cache-Control")).toBe("public, max-age=86400");

    const bytes = Buffer.from(await res.arrayBuffer());
    // PNG magic bytes — confirms a real image came back, not an empty body.
    expect(bytes.subarray(0, 8).toString("hex")).toBe("89504e470d0a1a0a");
  });

  it("requires no authentication — the code itself is the credential", async () => {
    const res = await GET(new Request("http://localhost/api/tickets/ANOTHER-CODE/qr.png"), {
      params: { ticketId: "ANOTHER-CODE" },
    });

    expect(res.status).toBe(200);
  });
});
