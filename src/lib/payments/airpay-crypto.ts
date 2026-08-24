import { createCipheriv, createHash, randomBytes } from "crypto";

/**
 * Implements the encryption/checksum scheme from Airpay Tanzania's
 * Collection API reference (merchant-provided PDF, not a public doc — see
 * airpay.ts for context on why that matters). A few details in that spec
 * are ambiguous by construction; each assumption is called out below and
 * needs confirming against Airpay's sandbox before this is trusted for a
 * real charge.
 */

export interface AirpayCredentials {
  merchantId: string;
  clientId: string;
  clientSecret: string;
  username: string;
  password: string;
  secret: string;
  merchantDomain: string;
}

export function readAirpayCredentials(): AirpayCredentials | null {
  const {
    AIRPAY_MERCHANT_ID: merchantId,
    AIRPAY_CLIENT_ID: clientId,
    AIRPAY_CLIENT_SECRET: clientSecret,
    AIRPAY_USERNAME: username,
    AIRPAY_PASSWORD: password,
    AIRPAY_SECRET: secret,
    AIRPAY_MERCHANT_DOMAIN: merchantDomain,
  } = process.env;
  if (!merchantId || !clientId || !clientSecret || !username || !password || !secret || !merchantDomain) {
    return null;
  }
  return { merchantId, clientId, clientSecret, username, password, secret, merchantDomain };
}

/**
 * encryption_key = md5(username + "~:~" + password)
 *
 * The doc gives this as a hex digest. AES-256-CBC needs a 32-byte key, and
 * an md5 hex digest is exactly 32 ASCII characters — so it's used directly
 * as the key's UTF-8 bytes (32 hex chars = 32 bytes), the same convention
 * several India-market payment gateways use for this exact scheme.
 */
export function deriveEncryptionKey(username: string, password: string): Buffer {
  const hex = createHash("md5").update(`${username}~:~${password}`).digest("hex");
  return Buffer.from(hex, "utf8");
}

/**
 * private_key = sha256(secret + "@" + username + ":|:" + password)
 *
 * Not used as cipher key material locally — it's a hex value sent alongside
 * encdata for Airpay to verify server-side.
 */
export function derivePrivateKey(secret: string, username: string, password: string): string {
  return createHash("sha256").update(`${secret}@${username}:|:${password}`).digest("hex");
}

/**
 * encdata = iv16 + base64(aes-256-cbc(json_payload, encryption_key, iv16))
 *
 * Assumption: "iv16" here means the 16-byte IV rendered as a 32-character
 * hex string and concatenated in front of the base64 ciphertext (not
 * base64'd itself, and not folded into the same base64 blob as the
 * ciphertext). Needs confirming against a real Airpay response before
 * relying on it — if decryption fails on their end, this is the first
 * place to check.
 */
export function encryptPayload(payload: Record<string, unknown>, encryptionKey: Buffer): string {
  const iv = randomBytes(16);
  const cipher = createCipheriv("aes-256-cbc", encryptionKey, iv);
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(payload), "utf8"), cipher.final()]);
  return iv.toString("hex") + ciphertext.toString("base64");
}

/**
 * checksum = sha256(concat(payload values sorted by key) + current_date_yyyy_mm_dd)
 *
 * Assumptions: "values sorted by key" means the object's own keys are
 * sorted alphabetically and only the (stringified) values are concatenated
 * in that order — key names themselves aren't part of the hashed string.
 * The date is rendered as ISO "YYYY-MM-DD" in UTC; if Airpay computes this
 * checksum against their own server's local date (Tanzania is UTC+3),
 * requests made close to midnight UTC could mismatch — worth confirming.
 * `date` is a parameter (not read from `new Date()` internally) purely so
 * this stays unit-testable without mocking the clock.
 */
export function buildChecksum(payload: Record<string, unknown>, date: Date = new Date()): string {
  const sortedValues = Object.keys(payload)
    .sort()
    .map((key) => String(payload[key]))
    .join("");
  const dateStr = date.toISOString().slice(0, 10);
  return createHash("sha256").update(sortedValues + dateStr).digest("hex");
}

export function base64MerchantDomain(domain: string): string {
  return Buffer.from(domain, "utf8").toString("base64");
}
