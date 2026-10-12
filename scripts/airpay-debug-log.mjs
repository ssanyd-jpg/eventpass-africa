/**
 * Fires the AirPay OAuth request and prints redacted logs to share with support.
 * Run from the project root:
 *   node scripts/airpay-debug-log.mjs
 *
 * Reads credentials from .env.local (or .env) — never prints them in plaintext.
 */

import { readFileSync } from "fs";
import { createHash, randomBytes } from "crypto";
import { createCipheriv } from "crypto";

// ── Load .env.local or .env ──────────────────────────────────────────────────
function loadEnv() {
  for (const file of [".env.local", ".env"]) {
    try {
      const lines = readFileSync(file, "utf8").split("\n");
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith("#")) continue;
        const eq = trimmed.indexOf("=");
        if (eq < 0) continue;
        const key = trimmed.slice(0, eq).trim();
        const val = trimmed.slice(eq + 1).trim().replace(/^["']|["']$/g, "");
        if (!(key in process.env)) process.env[key] = val;
      }
      console.log(`Loaded credentials from ${file}\n`);
      return;
    } catch {
      // try next
    }
  }
  console.error("Could not find .env.local or .env — exiting.");
  process.exit(1);
}

// ── Crypto (mirrors airpay-crypto.ts exactly) ────────────────────────────────
function deriveEncryptionKey(username, password) {
  return Buffer.from(
    createHash("md5").update(`${username}~:~${password}`).digest("hex"),
    "utf8"
  );
}

function buildChecksum(payload) {
  const sortedValues = Object.keys(payload)
    .sort()
    .map((k) => String(payload[k]))
    .join("");
  const dateStr = new Date().toISOString().slice(0, 10);
  return createHash("sha256").update(sortedValues + dateStr).digest("hex");
}

function redact(str) {
  if (!str || str.length < 8) return "***";
  return str.slice(0, 4) + "..." + str.slice(-4);
}

// ── Main ─────────────────────────────────────────────────────────────────────
loadEnv();

const {
  AIRPAY_MERCHANT_ID: merchantId,
  AIRPAY_CLIENT_ID: clientId,
  AIRPAY_CLIENT_SECRET: clientSecret,
  AIRPAY_USERNAME: username,
  AIRPAY_PASSWORD: password,
  AIRPAY_SECRET: secret,
  AIRPAY_MERCHANT_DOMAIN: merchantDomain,
} = process.env;

const missing = [
  ["AIRPAY_MERCHANT_ID", merchantId],
  ["AIRPAY_CLIENT_ID", clientId],
  ["AIRPAY_CLIENT_SECRET", clientSecret],
  ["AIRPAY_USERNAME", username],
  ["AIRPAY_PASSWORD", password],
  ["AIRPAY_SECRET", secret],
].filter(([, v]) => !v).map(([k]) => k);

if (missing.length) {
  console.error("Missing env vars:", missing.join(", "));
  process.exit(1);
}

const OAUTH_URL = "https://kraken.airpay.tz/airpay/pay/v1/api/oauth2/";

const payload = {
  client_id: clientId,
  client_secret: clientSecret,
  grant_type: "client_credentials",
  mercid: merchantId,
};

const encryptionKey = deriveEncryptionKey(username, password);

// Build encdata
const seed = randomBytes(16).toString("hex");
const iv = createHash("sha256").update(seed).digest("hex").slice(0, 16);
const cipher = createCipheriv("aes-256-cbc", encryptionKey, Buffer.from(iv, "utf8"));
const ciphertext = Buffer.concat([
  cipher.update(JSON.stringify(payload), "utf8"),
  cipher.final(),
]);
const encdata = iv + ciphertext.toString("base64");

const checksum = buildChecksum(payload);

const body = new URLSearchParams({
  merchant_id: merchantId,
  encdata,
  checksum,
}).toString();

// ── Print request log (redacted) ─────────────────────────────────────────────
console.log("=".repeat(60));
console.log("REQUEST");
console.log("=".repeat(60));
console.log(`POST ${OAUTH_URL}`);
console.log("Content-Type: application/x-www-form-urlencoded");
console.log("");
console.log("Form fields:");
console.log(`  merchant_id = ${merchantId}`);
console.log(`  encdata     = ${encdata}`);
console.log(`  checksum    = ${checksum}`);
console.log("");
console.log("Encrypted payload (inside encdata, shown for reference):");
console.log(`  client_id:     ${redact(clientId)}`);
console.log(`  client_secret: [REDACTED]`);
console.log(`  grant_type:    client_credentials`);
console.log(`  mercid:        ${merchantId}`);
console.log("");
console.log("Encryption details:");
console.log(`  key derivation: MD5(username + "~:~" + password)`);
console.log(`  username used:  ${redact(username)}`);
console.log(`  cipher:         AES-256-CBC`);
console.log(`  iv:             ${iv}  (first 16 chars of SHA256 of random seed)`);
console.log(`  checksum date:  ${new Date().toISOString().slice(0, 10)} (UTC)`);

// ── Fire the request ─────────────────────────────────────────────────────────
console.log("");
console.log("=".repeat(60));
console.log("RESPONSE");
console.log("=".repeat(60));

let status, headers, responseText;
try {
  const res = await fetch(OAUTH_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  status = res.status;
  headers = Object.fromEntries(res.headers.entries());
  responseText = await res.text();
} catch (err) {
  console.error("Network error:", err.message);
  process.exit(1);
}

console.log(`HTTP Status: ${status}`);
console.log("Response headers:");
for (const [k, v] of Object.entries(headers)) {
  console.log(`  ${k}: ${v}`);
}
console.log("");
console.log("Response body:");
console.log(responseText);

console.log("");
console.log("=".repeat(60));
console.log("SUMMARY");
console.log("=".repeat(60));
console.log(`Endpoint: ${OAUTH_URL}`);
console.log(`Merchant ID: ${merchantId}`);
console.log(`Result: HTTP ${status} — ${status === 200 ? "SUCCESS" : "FAILED"}`);
