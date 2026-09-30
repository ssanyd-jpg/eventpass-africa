import { handleUssd, verifyUssdSecret } from "@/lib/ussd";
import { checkRateLimit } from "@/lib/rate-limit";

// Africa's Talking requires text/plain — a JSON body (NextResponse.json)
// would be shown to the caller verbatim on their handset.
function ussdResponse(body: string, status = 200) {
  return new Response(body, { status, headers: { "Content-Type": "text/plain; charset=utf-8" } });
}

// No session auth — Africa's Talking calls this directly, so the only thing
// standing between the public internet and a wallet top-up is the shared
// secret header checked below (see DEPLOYMENT.md §8).
export async function POST(request: Request) {
  if (!verifyUssdSecret(request.headers.get("x-at-ussd-secret"))) {
    return ussdResponse("Unauthorized", 401);
  }

  try {
    // Africa's Talking posts application/x-www-form-urlencoded.
    const form = await request.formData();
    const field = (name: string) => {
      const value = form.get(name);
      return typeof value === "string" ? value : "";
    };

    const phoneNumber = field("phoneNumber");

    // The shared secret authenticates Africa's Talking as the caller, not
    // the handset — it doesn't stop one phone number from being spammed
    // (or from spamming the wallet-lookup/top-up logic) across many
    // sessions. 10/min is generous for a human clicking through menus
    // (a handful of screens over well under a minute) while still bounding
    // a runaway loop.
    const { allowed } = await checkRateLimit(`ussd:${phoneNumber}`, { limit: 10, windowMs: 60 * 1000 });
    if (!allowed) {
      return ussdResponse("END You're sending requests too fast. Please wait a moment and try again.");
    }

    const reply = await handleUssd({
      sessionId: field("sessionId"),
      serviceCode: field("serviceCode"),
      phoneNumber,
      text: field("text"),
    });
    return ussdResponse(reply);
  } catch (err) {
    // Always answer with a well-formed END — an uncaught 500 would leave the
    // caller on a hung "connection problem" screen instead of a message.
    console.error("[ussd] request failed", err);
    return ussdResponse("END Something went wrong. Please try again later");
  }
}
