import { describe, expect, it } from "vitest";
import { deriveSessionLabel } from "./session-label";

describe("deriveSessionLabel", () => {
  it("identifies Chrome on Windows", () => {
    const ua =
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36";
    expect(deriveSessionLabel(ua)).toBe("Chrome on Windows");
  });

  it("identifies Safari on iOS, not Chrome", () => {
    const ua =
      "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1";
    expect(deriveSessionLabel(ua)).toBe("Safari on iOS");
  });

  it("identifies Firefox on Linux", () => {
    const ua = "Mozilla/5.0 (X11; Linux x86_64; rv:128.0) Gecko/20100101 Firefox/128.0";
    expect(deriveSessionLabel(ua)).toBe("Firefox on Linux");
  });

  it("identifies Edge on Windows, not Chrome", () => {
    const ua =
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36 Edg/128.0.0.0";
    expect(deriveSessionLabel(ua)).toBe("Edge on Windows");
  });

  it("identifies Chrome on Mac", () => {
    const ua =
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36";
    expect(deriveSessionLabel(ua)).toBe("Chrome on Mac");
  });

  it("identifies Chrome on Android", () => {
    const ua = "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Mobile Safari/537.36";
    expect(deriveSessionLabel(ua)).toBe("Chrome on Android");
  });

  it("falls back to Unknown device for null/empty user-agent", () => {
    expect(deriveSessionLabel(null)).toBe("Unknown device");
    expect(deriveSessionLabel(undefined)).toBe("Unknown device");
    expect(deriveSessionLabel("")).toBe("Unknown device");
  });

  it("falls back to Unknown device for an unrecognizable user-agent", () => {
    expect(deriveSessionLabel("SomeWeirdBot/1.0")).toBe("Unknown device");
  });
});
