import { createDecipheriv } from "crypto";
import { describe, expect, it } from "vitest";
import {
  base64MerchantDomain,
  buildChecksum,
  decryptResponse,
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

    // encdata = <16-character IV string> + <base64 ciphertext>, matching
    // Airpay's reference PHP exactly — the IV is 16 raw characters (not
    // hex-re-encoded, not base64), only the ciphertext is base64'd.
    const ivString = encdata.slice(0, 16);
    const ciphertextB64 = encdata.slice(16);
    const iv = Buffer.from(ivString, "utf8");
    const decipher = createDecipheriv("aes-256-cbc", key, iv);
    const decrypted = Buffer.concat([decipher.update(Buffer.from(ciphertextB64, "base64")), decipher.final()]);

    expect(JSON.parse(decrypted.toString("utf8"))).toEqual(payload);
  });

  it("encdata's leading 16 characters are the raw IV, not hex-encoded", () => {
    const encdata = encryptPayload({ orderid: "ORD123" }, key);
    const ivString = encdata.slice(0, 16);
    expect(ivString).toHaveLength(16);
    expect(ivString).toMatch(/^[a-f0-9]{16}$/);
  });

  it("uses a fresh random IV each call, so encdata differs even for identical payloads", () => {
    const payload = { orderid: "ORD123" };
    const first = encryptPayload(payload, key);
    const second = encryptPayload(payload, key);
    expect(first).not.toBe(second);
  });
});

describe("decryptResponse", () => {
  const key = deriveEncryptionKey("merchant_user", "s3cret-pass");

  it("round-trips: decrypting what encryptPayload produced recovers the original data", () => {
    const payload = { data: { access_token: "abc123xyz", expires_in: 3600 } };
    const encrypted = encryptPayload(payload, key);

    expect(decryptResponse(encrypted, key)).toEqual(payload);
  });

  it("fails to decrypt (rather than silently returning garbage) under the wrong key", () => {
    const wrongKey = deriveEncryptionKey("other_user", "s3cret-pass");
    const encrypted = encryptPayload({ data: { access_token: "abc123xyz" } }, key);

    expect(() => decryptResponse(encrypted, wrongKey)).toThrow();
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
