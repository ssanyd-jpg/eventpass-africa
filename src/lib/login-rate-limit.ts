import { checkRateLimit, resetRateLimit } from "@/lib/rate-limit";

const LOGIN_LIMIT = 5;
const LOGIN_WINDOW_MS = 15 * 60 * 1000;

function emailKey(email: string): string {
  return `login:${email.toLowerCase()}`;
}

function ipKey(ip: string): string {
  return `login-ip:${ip}`;
}

/**
 * Two independent buckets: per-email (catches repeated guesses against one
 * account) and per-IP (catches credential stuffing across many accounts
 * from one source). Either tripping blocks the attempt. Both buckets still
 * record a hit even when the other one is what ultimately blocks — same
 * "checking costs a hit" behavior as every other checkRateLimit call in
 * this codebase, not worth special-casing for one extra saved row.
 */
export async function checkLoginRateLimit(email: string, ip: string): Promise<boolean> {
  const emailResult = await checkRateLimit(emailKey(email), { limit: LOGIN_LIMIT, windowMs: LOGIN_WINDOW_MS });
  const ipResult = await checkRateLimit(ipKey(ip), { limit: LOGIN_LIMIT, windowMs: LOGIN_WINDOW_MS });
  return emailResult.allowed && ipResult.allowed;
}

export async function resetLoginRateLimit(email: string, ip: string): Promise<void> {
  await Promise.all([resetRateLimit(emailKey(email)), resetRateLimit(ipKey(ip))]);
}
