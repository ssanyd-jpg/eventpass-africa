import { describe, expect, it } from "vitest";
import { resolveOfflineChargeMessage } from "@/lib/wallet-charge";

describe("resolveOfflineChargeMessage", () => {
  it("returns the split-specific message when the local balance can't cover the amount", () => {
    expect(resolveOfflineChargeMessage(30000, 100000)).toBe(
      "Split payment requires a connection — ask the attendee to top up first at a top-up station."
    );
  });

  it("returns the generic offline message when the local balance covers the amount", () => {
    expect(resolveOfflineChargeMessage(150000, 100000)).toBe("Charging requires an online connection.");
  });

  it("returns the generic offline message when the wallet isn't resolved locally at all", () => {
    expect(resolveOfflineChargeMessage(null, 100000)).toBe("Charging requires an online connection.");
  });
});
