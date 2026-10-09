/**
 * One-off: send a real WhatsApp message through the actual
 * src/lib/whatsapp.ts sendWhatsApp() function to confirm Africa's Talking
 * WhatsApp delivery. Falls back to SMS (see sendWhatsApp's own comment) if
 * AT_WHATSAPP_USERNAME/AT_WHATSAPP_SHORTCODE aren't configured for real
 * production WhatsApp.
 *
 * Run:  npx tsx --env-file=.env scripts/test-whatsapp.ts
 *
 * Not committed — ad-hoc verification only.
 */
import { sendWhatsApp } from "../src/lib/whatsapp";

const TO = "+255715400111";
const MESSAGE =
  "Chaap WhatsApp test — if you received this, WhatsApp notifications are working. chaap.africa";

async function main() {
  const hasWhatsAppCreds = Boolean(
    process.env.AT_API_KEY && process.env.AT_WHATSAPP_USERNAME && process.env.AT_WHATSAPP_SHORTCODE
  );
  console.log(
    `Sending to ${TO} (WhatsApp credentials ${hasWhatsAppCreds ? "present" : "NOT present — expect SMS fallback"})...`
  );

  const result = await sendWhatsApp({ to: TO, message: MESSAGE });

  console.log("\nResult:", result);

  if (!result.ok) {
    console.error(`\nSend did not report ok — see [whatsapp]/[sms] error above.`);
    process.exit(1);
  }

  console.log(`\nSent successfully via ${result.channel}.`);
}

main().catch((err) => {
  console.error("\nWhatsApp test failed:", err);
  process.exit(1);
});
