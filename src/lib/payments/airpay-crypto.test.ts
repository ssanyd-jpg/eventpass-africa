import { createDecipheriv } from "crypto";
import { describe, expect, it } from "vitest";
import {
  base64MerchantDomain,
  buildChecksum,
  deriveEncryptionKey,
  derivePrivateKey,
  encryptPayload,
} from "./airpay-crypto";

describe("deriveEncryptionKey", () => {
  it("produces a 32-byte key suitable for AES-256", () => {
    const key = deriveEncryptionKey("merchant_user", "s3cret-pass");
    expect(key.length).toBe(32);
  });

  it("is deterministic for the same username/password", () => {
    const a = deriveEncryptionKey("merchant_user", "s3cret-pass");
    const b = deriveEncryptionKey("merchant_user", "s3cret-pass");
    expect(a.equals(b)).toBe(true);
  });

  it("changes if either input changes", () => {
    const a = deriveEncryptionKey("merchant_user", "s3cret-pass");
    const b = deriveEncryptionKey("other_user", "s3cret-pass");
    expect(a.equals(b)).toBe(false);
  });
});

describe("derivePrivateKey", () => {
  it("returns a 64-character sha256 hex digest", () => {
    const key = derivePrivateKey("shh", "merchant_user", "s3cret-pass");
    expect(key).toMatch(/^[a-f0-9]{64}$/);
  });

  it("is deterministic for the same inputs", () => {
    const a = derivePrivateKey("shh", "merchant_user", "s3cret-pass");
    const b = derivePrivateKey("shh", "merchant_user", "s3cret-pass");
    expect(a).toBe(b);
  });
});

describe("encryptPayload", () => {
  const key = deriveEncryptionKey("merchant_user", "s3cret-pass");

  it("round-trips: decrypting encdata recovers the original JSON payload", () => {
    const payload = { orderid: "ORD123", amount: "1000.00", bankcode: "TIGO" };
    const encdata = encryptPayload(payload, key);

    // encdata = <32 hex chars of IV> + <base64 ciphertext>, per airpay-crypto.ts.
    const ivHex = encdata.slice(0, 32);
    const ciphertextB64 = encdata.slice(32);
    const iv = Buffer.from(ivHex, "hex");
    const decipher = createDecipheriv("aes-256-cbc", key, iv);
    const decrypted = Buffer.concat([decipher.update(Buffer.from(ciphertextB64, "base64")), decipher.final()]);

    expect(JSON.parse(decrypted.toString("utf8"))).toEqual(payload);
  });

  it("uses a fresh random IV each call, so encdata differs even for identical payloads", () => {
    const payload = { orderid: "ORD123" };
    const first = encryptPayload(payload, key);
    const second = encryptPayload(payload, key);
    expect(first).not.toBe(second);
  });
});

describe("buildChecksum", () => {
  it("is deterministic for the same payload and date", () => {
    const payload = { b: "2", a: "1" };
    const date = new Date("2026-08-21T10:00:00Z");
    expect(buildChecksum(payload, date)).toBe(buildChecksum(payload, date));
  });

  it("only depends on values, not key names — reordering keys with the same values doesn't change it", () => {
    const date = new Date("2026-08-21T10:00:00Z");
    const a = buildChecksum({ a: "x", b: "y" }, date);
    const b = buildChecksum({ b: "y", a: "x" }, date);
    expect(a).toBe(b);
  });

  it("changes when the date changes", () => {
    const payload = { a: "1" };
    const day1 = buildChecksum(payload, new Date("2026-08-21T10:00:00Z"));
    const day2 = buildChecksum(payload, new Date("2026-08-22T10:00:00Z"));
    expect(day1).not.toBe(day2);
  });

  it("returns a 64-character sha256 hex digest", () => {
    expect(buildChecksum({ a: "1" }, new Date())).toMatch(/^[a-f0-9]{64}$/);
  });
});

describe("base64MerchantDomain", () => {
  it("base64-encodes the domain", () => {
    expect(base64MerchantDomain("https://example.com")).toBe(
      Buffer.from("https://example.com", "utf8").toString("base64")
    );
  });
});
