import type { ChargeRequest, ChargeResult, PaymentProvider } from "./types";
import {
  base64MerchantDomain,
  buildChecksum,
  decryptResponse,
  deriveEncryptionKey,
  derivePrivateKey,
  encryptPayload,
  readAirpayCredentials,
  type AirpayCredentials,
} from "./airpay-crypto";

/**
 * Airpay Tanzania — the chosen aggregator for real mobile money charging.
 * Airpay fronts three Tanzanian mobile money networks today (M-Pesa, Tigo
 * Pesa / MIXX by Yas, Airtel Money) behind one merchant integration
 * ("Seamless mobile money"), so checkout doesn't need a separate adapter per
 * network. HaloPesa and T-Pesa are NOT yet available on Airpay Tanzania —
 * confirmed directly by Airpay support — so neither is offered as a
 * checkout option; see mapNetworkToBankcode below.
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

const OAUTH_URL = "https://kraken.airpay.tz/airpay/pay/v1/api/oauth2/";
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
  // Exactly these four fields, keyed "mercid" (not "merchant_id") — confirmed
  // against Airpay's reference PHP. A stray extra "merchant_id" key here
  // previously polluted both the checksum (wrong concatenated value order)
  // and encdata (an extra field the server doesn't expect).
  const payload = {
    client_id: creds.clientId,
    client_secret: creds.clientSecret,
    grant_type: "client_credentials",
    mercid: creds.merchantId,
  };
  const encryptionKey = deriveEncryptionKey(creds.username, creds.password);
  const data = await postForm(OAUTH_URL, {
    merchant_id: creds.merchantId,
    encdata: encryptPayload(payload, encryptionKey),
    checksum: buildChecksum(payload),
  });

  // Confirmed live against Airpay's OAuth endpoint: the token isn't a plain
  // field — the whole body is { merchant_id, response: "<encrypted blob>" },
  // encrypted with the same secretKey used for encdata. See decryptResponse.
  const encryptedResponse = data.response as string | undefined;
  if (!encryptedResponse) {
    throw new Error(`Airpay OAuth response didn't include an encrypted "response" field: ${JSON.stringify(data)}`);
  }
  const decrypted = decryptResponse(encryptedResponse, encryptionKey);
  const nested = decrypted.data as { access_token?: string } | undefined;
  const token = nested?.access_token;
  if (!token) {
    throw new Error(`Airpay OAuth decrypted response didn't include data.access_token: ${JSON.stringify(decrypted)}`);
  }
  return token;
}

// Confirmed with Airpay support: MPESA, AIRTEL, and TIGO (Tigo Pesa / MIXX
// by Yas) are the only bankcodes Airpay Tanzania currently accepts.
// HALOTEL/HaloPesa and T-Pesa are NOT yet available on their side — there is
// deliberately no case for either here, and no checkout UI offers them as
// an option (see mobileNetwork's zod enums in sync-handlers.ts and every
// NETWORKS selector across src/app). An unrecognized network still falls
// through to MPESA rather than throwing, same as before this confirmation.
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
      buyer_email: "buyer@chaap.dev",
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
      // chmod/txnsubtype/channel/currency_code (a number, not a string)/
      // iso_currency, plus buyer_phone above stripped to a bare local
      // subscriber number — every one of these is a fixed value confirmed
      // directly by Airpay support, not still-unverified assumptions.
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

// Plausible field names Airpay's Order Verification response might use to
// echo the order id back — never confirmed against a real response (the
// merchant PDF this was built from doesn't show a worked example for this
// call), so this is checked defensively, not assumed authoritative. See
// verifyAirpayOrder's own comment on how an absent field is treated
// differently from a present-but-mismatched one.
const ORDER_ID_ECHO_KEYS = ["ORDERID", "orderid", "merchant_txnId", "MERCHANT_TXNID", "OrderId"] as const;

/**
 * Resolves a PENDING charge to its final status by polling Order
 * Verification (there's no webhook to receive this — see the note above).
 * Not part of the generic PaymentProvider interface since it's specific to
 * Airpay's poll-based design.
 *
 * Hardened against three gaps found reviewing this function for
 * reconciliation-readiness:
 *   - Response substitution: if the response echoes an order id under any
 *     of ORDER_ID_ECHO_KEYS and it doesn't match what was requested, that's
 *     treated as a mismatched/untrustworthy response (FAILED), not silently
 *     accepted. Since it isn't confirmed whether Airpay's real response
 *     ever includes this field, an ABSENT field is not itself an error —
 *     only a PRESENT-but-different one is.
 *   - Unrecognized shape: previously a response with neither
 *     TRANSACTIONSTATUS nor status silently fell through to PENDING with no
 *     visibility. It still resolves to PENDING (the safe default — retried
 *     next sweep, never wrongly marks something PAID/FAILED on no
 *     evidence), but now logs a warning so a genuinely broken integration
 *     doesn't look identical to "still waiting on the buyer" in the logs.
 *   - No verification trail: every call now logs the order id and the
 *     status it resolved to, for reconciliation against Airpay's own
 *     records.
 *
 * One real behavior fix, not just added logging: the old ternary only
 * checked `transactionStatus === undefined` to decide "no recognizable
 * status" — a response with `status: "failed"` but no TRANSACTIONSTATUS
 * field fell into that branch and was wrongly returned as PENDING (a
 * declined payment would have silently stayed "pending" forever instead of
 * failing). `hasStatusField` now also counts `data.status` being present,
 * so that case correctly resolves to FAILED.
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

  for (const key of ORDER_ID_ECHO_KEYS) {
    const echoed = data[key];
    if (typeof echoed === "string" && echoed !== "" && echoed !== merchantOrderId) {
      console.error(`[airpay] verifyAirpayOrder: response order id "${echoed}" (${key}) doesn't match requested "${merchantOrderId}" — rejecting as untrustworthy.`);
      return { status: "FAILED", reference: merchantOrderId, message: "Airpay's verification response didn't match the requested order — treated as failed." };
    }
  }

  const transactionStatus = data.TRANSACTIONSTATUS as string | undefined;
  const hasStatusField = transactionStatus !== undefined || typeof data.status === "string";
  const status =
    transactionStatus === "200" || data.status === "success"
      ? "PAID"
      : !hasStatusField
        ? "PENDING"
        : "FAILED";

  if (!hasStatusField) {
    console.warn(`[airpay] verifyAirpayOrder: unrecognized response shape for order "${merchantOrderId}" — treating as still PENDING. Raw response: ${JSON.stringify(data)}`);
  }
  console.log(`[airpay] verifyAirpayOrder: order "${merchantOrderId}" resolved to ${status}`);

  return {
    status,
    reference: merchantOrderId,
    message: (data.MESSAGE as string) ?? (data.message as string),
  };
}
