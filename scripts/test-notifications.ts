/**
 * One-off: send a real EMAIL notification through the actual
 * src/lib/notifications.ts choke point (same path every order
 * confirmation / password reset / etc. goes through) to confirm Resend
 * delivery now that the sending domain is verified.
 *
 * Run:  npx tsx --env-file=.env scripts/test-notifications.ts
 */
import { sendNotification } from "../src/lib/notifications";

const REQUIRED_ENV = ["RESEND_API_KEY", "CHAAP_FROM_EMAIL"];

async function main() {
  const missing = REQUIRED_ENV.filter((name) => !process.env[name]);
  if (missing.length > 0) {
    console.error("Missing env vars (no email was sent):");
    for (const name of missing) console.error(`  - ${name}`);
    process.exit(1);
  }

  console.log(`Sending from ${process.env.CHAAP_FROM_EMAIL} to ssanyd@gmail.com via Resend...`);

  const log = await sendNotification({
    type: "PASSWORD_RESET",
    channel: "EMAIL",
    recipient: "ssanyd@gmail.com",
    subject: "Chaap — test notification",
    body: `This is a one-off delivery test sent ${new Date().toISOString()} to confirm the noreply@chaap.africa sending domain is verified in Resend.`,
  });

  console.log("\nNotificationLog row:", { id: log.id, status: log.status });

  if (log.status !== "SENT") {
    console.error(`\nSend did not report SENT (got "${log.status}") — check the [email] logs above for the Resend error.`);
    process.exit(1);
  }

  console.log("\nSent successfully.");
}

main().catch((err) => {
  console.error("\nNotification test failed:", err);
  process.exit(1);
});
