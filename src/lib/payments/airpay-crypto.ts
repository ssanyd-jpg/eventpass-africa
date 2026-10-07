import { createCipheriv, createDecipheriv, createHash, randomBytes } from "crypto";

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
 * encdata = iv + base64(aes-256-cbc(json_payload, encryption_key, iv))
 *
 * Confirmed against Airpay's reference PHP:
 *   $iv = substr(hash('sha256', uniqid()), 0, 16);
 *   $encrypted = openssl_encrypt($data, 'AES-256-CBC', $key, OPENSSL_RAW_DATA, $iv);
 *   return $iv . base64_encode($encrypted);
 *
 * The IV is the first 16 *characters* of a sha256 hex digest — a 16-byte
 * ASCII string, used directly as the raw CBC IV (not re-encoded as hex, not
 * a cryptographically random 16-byte buffer). The output concatenates that
 * same 16-character string in front of the base64 ciphertext — the IV
 * itself is never base64'd. randomBytes(16).toString("hex") stands in for
 * PHP's uniqid() as the per-call random seed fed into sha256; only the
 * sha256 output is used as the IV, same as the PHP.
 */
export function encryptPayload(payload: Record<string, unknown>, encryptionKey: Buffer): string {
  const seed = randomBytes(16).toString("hex");
  const iv = createHash("sha256").update(seed).digest("hex").slice(0, 16);
  const cipher = createCipheriv("aes-256-cbc", encryptionKey, Buffer.from(iv, "utf8"));
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(payload), "utf8"), cipher.final()]);
  return iv + ciphertext.toString("base64");
}

/**
 * Inverse of encryptPayload — decrypts an Airpay response blob of the same
 * shape (16-character raw IV + base64 ciphertext). Confirmed live against
 * Airpay's OAuth endpoint: it returns { merchant_id, response: "<this>" },
 * encrypted with the same md5-derived secretKey used to encrypt encdata.
 * Matches Airpay's reference PHP decryptData():
 *   iv = substr(response, 0, 16); encryptedData = substr(response, 16);
 *   decrypted = openssl_decrypt(base64_decode(encryptedData), 'AES-256-CBC', secretKey, OPENSSL_RAW_DATA, iv);
 */
export function decryptResponse(encryptedBlob: string, encryptionKey: Buffer): Record<string, unknown> {
  const iv = encryptedBlob.slice(0, 16);
  const ciphertextB64 = encryptedBlob.slice(16);
  const decipher = createDecipheriv("aes-256-cbc", encryptionKey, Buffer.from(iv, "utf8"));
  const decrypted = Buffer.concat([decipher.update(Buffer.from(ciphertextB64, "base64")), decipher.final()]);
  return JSON.parse(decrypted.toString("utf8"));
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
