/**
 * One-off: initiate an AirPay Tanzania sandbox top-up through the real
 * src/lib/payments/airpay.ts provider and log everything AirPay sends back.
 *
 * Run:  npx tsx --env-file=.env scripts/test-airpay.ts
 *
 * airpayProvider.initiateCharge() only returns the mapped { status, reference,
 * message }, not AirPay's raw JSON. To log the full response without touching
 * the library, this script wraps global fetch and prints each raw response
 * body as it comes back. Request bodies are encrypted, so only the URL is
 * shown; the OAuth access token and the ?token= query value are masked.
 */
import { airpayProvider } from "../src/lib/payments/airpay";

const REQUIRED_ENV = [
  "AIRPAY_MERCHANT_ID",
  "AIRPAY_CLIENT_ID",
  "AIRPAY_CLIENT_SECRET",
  "AIRPAY_USERNAME",
  "AIRPAY_PASSWORD",
  "AIRPAY_SECRET",
  "AIRPAY_MERCHANT_DOMAIN",
];

const TOKEN_KEYS = new Set(["token", "accessToken", "access_token"]);

function maskTokens(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(maskTokens);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [k, TOKEN_KEYS.has(k) && typeof v === "string" ? "<masked>" : maskTokens(v)]),
    );
  }
  return value;
}

function installFetchLogger() {
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const url = String(input instanceof Request ? input.url : input).replace(/([?&]token=)[^&]*/, "$1<masked>");
    console.log(`\n--> ${init?.method ?? "GET"} ${url}`);
    const res = await realFetch(input, init);
    const text = await res.clone().text();
    let body: unknown = text;
    try {
      body = maskTokens(JSON.parse(text));
    } catch {
      // not JSON — print as-is
    }
    console.log(`<-- HTTP ${res.status} ${res.statusText}`);
    console.log(typeof body === "string" ? body : JSON.stringify(body, null, 2));
    return res;
  };
}

async function main() {
  const missing = REQUIRED_ENV.filter((name) => !process.env[name]);
  if (missing.length > 0) {
    console.error("Missing AirPay env vars (no request was sent):");
    for (const name of missing) console.error(`  - ${name}`);
    process.exit(1);
  }

  installFetchLogger();

  const request = {
    orderClientId: `sandbox-test-${Date.now()}`,
    amountCents: 500_000, // TZS 5,000 — airpay.ts sends (amountCents / 100).toFixed(2)
    phoneNumber: "+255715400111",
    mobileNetwork: "airtel", // mapNetworkToBankcode upper-cases this -> "AIRTEL"
    description: "Sandbox top-up test",
  };
  console.log("Request:", request);

  const result = await airpayProvider.initiateCharge(request);
  console.log("\nMapped ChargeResult:", result);
}

main().catch((err) => {
  console.error("\nAirPay test failed:", err);
  process.exit(1);
});
