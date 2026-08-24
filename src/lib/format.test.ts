import { describe, expect, it } from "vitest";
import { formatCents, generateTicketCode, slugify } from "./format";

// Intl's currency formatter joins "TZS" and the amount with a non-breaking
// space (U+00A0), not a regular one — built via charCode to avoid any
// ambiguity about which whitespace character actually ends up in this file.
const NBSP = String.fromCharCode(160);

describe("formatCents", () => {
  it("formats whole-shilling amounts with no decimals", () => {
    expect(formatCents(2000000)).toBe(`TZS${NBSP}20,000`);
  });

  it("rounds to the nearest shilling rather than showing cents", () => {
    expect(formatCents(1500050)).toBe(`TZS${NBSP}15,001`); // 15,000.50 rounds up
  });

  it("handles zero", () => {
    expect(formatCents(0)).toBe(`TZS${NBSP}0`);
  });

  it("defaults to TZS when no currency is given", () => {
    expect(formatCents(500000)).toBe(formatCents(500000, "TZS"));
  });

  it("shows two decimal places for non-zero-decimal currencies like USD", () => {
    expect(formatCents(6500, "USD")).toBe("$65.00");
    expect(formatCents(0, "USD")).toBe("$0.00");
  });

  it("shows no decimals for other zero-decimal East African currencies too", () => {
    expect(formatCents(500000, "UGX")).toBe(`UGX${NBSP}5,000`);
    expect(formatCents(300000, "RWF")).toBe(`RWF${NBSP}3,000`);
  });

  it("shows two decimals for a non-zero-decimal African currency like KES", () => {
    expect(formatCents(2500000, "KES")).toBe(`KES${NBSP}25,000.00`);
  });
});

describe("slugify", () => {
  it("lowercases and hyphenates", () => {
    expect(slugify("Bongo Beats Festival")).toBe("bongo-beats-festival");
  });

  it("strips non-alphanumeric characters", () => {
    expect(slugify("Dar Comedy Night: Live!")).toBe("dar-comedy-night-live");
  });

  it("trims leading/trailing hyphens", () => {
    expect(slugify("  --Zanzibar Acoustic--  ")).toBe("zanzibar-acoustic");
  });
});

describe("generateTicketCode", () => {
  it("produces a 10-character code with a hyphen after the 5th character", () => {
    const code = generateTicketCode();
    expect(code).toMatch(/^[A-Z0-9]{5}-[A-Z0-9]{5}$/);
  });

  it("never includes visually ambiguous characters (0/O, 1/I)", () => {
    for (let i = 0; i < 200; i++) {
      const code = generateTicketCode();
      expect(code).not.toMatch(/[01IO]/);
    }
  });

  it("generates unique codes across many calls", () => {
    const codes = new Set(Array.from({ length: 500 }, () => generateTicketCode()));
    expect(codes.size).toBe(500);
  });
});
