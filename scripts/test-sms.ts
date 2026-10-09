/**
 * One-off: send a real SMS through the actual src/lib/sms.ts sendSMS()
 * function (same adapter every WhatsApp-fallback / low-balance / reminder
 * SMS goes through) to confirm Africa's Talking delivery and the AT_SENDER_ID
 * ("CHAAP") now that it's wired in.
 *
 * Run:  npx tsx --env-file=.env scripts/test-sms.ts
 *
 * Not committed — ad-hoc verification only.
 */
import { sendSMS } from "../src/lib/sms";

const TO = "+255677556000";
const MESSAGE =
  "Chaap SMS test — if you received this showing CHAAP as sender, Africa's Talking is working. chaap.africa";

async function main() {
  console.log(`Sending to ${TO} via Africa's Talking (sender: ${process.env.AT_SENDER_ID ?? "unset"})...`);

  const result = await sendSMS({ to: TO, message: MESSAGE });

  console.log("\nResult:", result);

  if (!result.ok) {
    console.error(`\nSend did not report ok — see [sms] error above.`);
    process.exit(1);
  }

  console.log("\nSent successfully.");
}

main().catch((err) => {
  console.error("\nSMS test failed:", err);
  process.exit(1);
});
