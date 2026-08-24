import { prisma } from "@/lib/prisma";

interface RateLimitOptions {
  limit: number;
  windowMs: number;
}

/**
 * Fixed-window, DB-backed rate limit — no Redis/Upstash needed. Serverless
 * functions are stateless per-invocation, so in-memory counters don't work
 * across instances; this uses the same Postgres/SQLite database the app
 * already has. Self-trims opportunistically instead of needing a cron job.
 */
export async function checkRateLimit(
  bucketKey: string,
  { limit, windowMs }: RateLimitOptions
): Promise<{ allowed: boolean; remaining: number }> {
  const windowStart = new Date(Date.now() - windowMs);

  const count = await prisma.rateLimitHit.count({
    where: { bucketKey, createdAt: { gte: windowStart } },
  });

  if (count >= limit) {
    return { allowed: false, remaining: 0 };
  }

  await prisma.rateLimitHit.create({ data: { bucketKey } });

  if (Math.random() < 0.01) {
    // opportunistic cleanup — self-trims the table without a scheduled job
    prisma.rateLimitHit
      .deleteMany({ where: { createdAt: { lt: windowStart } } })
      .catch(() => {});
  }

  return { allowed: true, remaining: limit - count - 1 };
}

export function clientIp(request: Request): string {
  const forwarded = request.headers.get("x-forwarded-for");
  return forwarded?.split(",")[0]?.trim() ?? "unknown";
}
