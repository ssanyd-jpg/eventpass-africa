import type { ChargeRequest, ChargeResult, PaymentProvider } from "./types";
import {
  base64MerchantDomain,
  buildChecksum,
  deriveEncryptionKey,
  derivePrivateKey,
  encryptPayload,
  readAirpayCredentials,
  type AirpayCredentials,
} from "./airpay-crypto";

/**
 * Airpay Tanzania — the chosen aggregator for real mobile money charging.
 * Airpay fronts the major Tanzanian mobile money networks (M-Pesa, Tigo
 * Pesa, Airtel Money, HaloPesa) behind one merchant integration ("Seamless
 * mobile money"), so checkout doesn't need a separate adapter per network.
 *
 * Built from a merchant-provided API reference PDF, not Airpay's public
 * site (they don't publish this — see the README's "Simulated pieces"
 * section). That PDF isn't independently verifiable as their live spec,
 * and it documents several response shapes as "possible" rather than
 * definitive, so treat this implementation as a best-faith reading that
 * needs confirming against Airpay's actual sandbox before any real charge
 * runs through it — see the ambiguities called out in airpay-crypto.ts.
 *
 * Not wired to checkout yet: AIRPAY_MERCHANT_ID etc. are never set today,
 * so isConfigured() is always false and index.ts falls back to the
 * simulator. Separately, wiring this into checkout is its own decision
 * (see README) since a real charge is asynchronous — the buyer has to
 * confirm on their own phone.
 *
 * No webhook route exists for this — the documented API is poll-based
 * (Order Verification), not callback-based. verifyAirpayOrder() below is
 * what a background job or status-check route would call to resolve a
 * PENDING charge.
 */

const OAUTH_URL = "https://kraken.airpay.tz/airpay/pay/v1/api/oauth2";
const SEAMLESS_URL = "https://kraken.airpay.tz/airpay/pay/v1/api/seamless/index.php";
const VERIFY_URL = "https://payments.airpay.tz/order/verify.php";

async function postForm(url: string, fields: Record<string, string>): Promise<Record<string, unknown>> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(fields).toString(),
  });
  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`Airpay returned a non-JSON response (HTTP ${res.status}): ${text.slice(0, 300)}`);
  }
}

async function getAccessToken(creds: AirpayCredentials): Promise<string> {
  const payload = {
    client_id: creds.clientId,
    client_secret: creds.clientSecret,
    grant_type: "client_credentials",
    merchant_id: creds.merchantId,
    mercid: creds.merchantId,
  };
  const encryptionKey = deriveEncryptionKey(creds.username, creds.password);
  const data = await postForm(OAUTH_URL, {
    merchant_id: creds.merchantId,
    encdata: encryptPayload(payload, encryptionKey),
    checksum: buildChecksum(payload),
  });

  // The spec documents three possible token response shapes — tolerate all.
  const nested = data.data as { access_token?: string } | undefined;
  const token = (data.token as string | undefined) ?? (data.accessToken as string | undefined) ?? nested?.access_token;
  if (!token) {
    throw new Error(`Airpay OAuth response didn't include a recognizable token: ${JSON.stringify(data)}`);
  }
  return token;
}

function mapNetworkToBankcode(network?: string): string {
  switch ((network ?? "").toUpperCase()) {
    case "TIGO":
    case "TIGO_PESA":
      return "TIGO";
    case "AIRTEL":
    case "AIRTEL_MONEY":
      return "AIRTEL";
    case "MPESA":
    case "M-PESA":
    case "VODACOM":
    default:
      return "MPESA";
  }
}

/**
 * The Seamless example in the spec uses a bare 9-digit subscriber number
 * ("717588599", no leading 255/0) while the Hosted Checkout example on the
 * same page uses full E.164 ("255717588599") — the two examples disagree
 * with each other. Going with the Seamless-specific example since that's
 * the flow actually used here.
 */
function toLocalSubscriberNumber(phone: string): string {
  const digits = phone.replace(/\D/g, "");
  if (digits.startsWith("255")) return digits.slice(3);
  if (digits.startsWith("0")) return digits.slice(1);
  return digits;
}

export const airpayProvider: PaymentProvider = {
  name: "AIRPAY_TZ",
  isConfigured: () => readAirpayCredentials() !== null,

  async initiateCharge(req: ChargeRequest): Promise<ChargeResult> {
    const creds = readAirpayCredentials();
    if (!creds) {
      throw new Error("Airpay credentials are not fully set — airpayProvider isn't usable yet.");
    }
    if (!req.phoneNumber) {
      return { status: "FAILED", reference: "", message: "A phone number is required for mobile money checkout." };
    }

    const accessToken = await getAccessToken(creds);
    const orderid = `AP${req.orderClientId.replace(/[^a-zA-Z0-9]/g, "").slice(-24)}`;

    const payload = {
      buyer_email: "buyer@eventpassafrica.dev",
      buyer_phone: toLocalSubscriberNumber(req.phoneNumber),
      buyer_firstname: "Guest",
      buyer_lastname: "Buyer",
      buyer_address: "",
      buyer_city: "",
      buyer_state: "",
      buyer_country: "TZ",
      buyer_pincode: "",
      orderid,
      amount: (req.amountCents / 100).toFixed(2),
      mer_dom: base64MerchantDomain(creds.merchantDomain),
      customvar: req.orderClientId,
      chmod: "mmoney",
      txnsubtype: "2",
      channel: "mmoney",
      bankcode: mapNetworkToBankcode(req.mobileNetwork),
      currency_code: 834,
      iso_currency: "TZS",
      merchant_id: creds.merchantId,
    };

    const encryptionKey = deriveEncryptionKey(creds.username, creds.password);
    const data = await postForm(`${SEAMLESS_URL}?token=${encodeURIComponent(accessToken)}`, {
      merchant_id: creds.merchantId,
      privatekey: derivePrivateKey(creds.secret, creds.username, creds.password),
      encdata: encryptPayload(payload, encryptionKey),
      checksum: buildChecksum(payload),
    });

    // The spec documents several possible response shapes for this call —
    // tolerate all of them rather than assuming one is authoritative.
    const failed = data.status === "fail" || data.success === false;
    if (failed) {
      return { status: "FAILED", reference: orderid, message: (data.message as string) ?? "Airpay declined the charge." };
    }
    return {
      status: "PENDING",
      reference: orderid,
      message: (data.message as string) ?? "Awaiting buyer confirmation on their phone.",
    };
  },
};

/**
 * Resolves a PENDING charge to its final status by polling Order
 * Verification (there's no webhook to receive this — see the note above).
 * Not part of the generic PaymentProvider interface since it's specific to
 * Airpay's poll-based design.
 */
export async function verifyAirpayOrder(merchantOrderId: string): Promise<ChargeResult> {
  const creds = readAirpayCredentials();
  if (!creds) {
    throw new Error("Airpay credentials are not fully set — airpayProvider isn't usable yet.");
  }
  const data = await postForm(VERIFY_URL, {
    Mercid: creds.merchantId,
    merchant_txnId: merchantOrderId,
    Privatekey: derivePrivateKey(creds.secret, creds.username, creds.password),
  });

  const transactionStatus = data.TRANSACTIONSTATUS as string | undefined;
  const status = transactionStatus === "200" || data.status === "success" ? "PAID" : transactionStatus === undefined ? "PENDING" : "FAILED";
  return {
    status,
    reference: merchantOrderId,
    message: (data.MESSAGE as string) ?? (data.message as string),
  };
}
