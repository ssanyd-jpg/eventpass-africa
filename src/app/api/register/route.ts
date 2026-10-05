import { NextResponse } from "next/server";
import bcrypt from "bcryptjs";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { checkRateLimit, clientIp } from "@/lib/rate-limit";
import { createPersonalOrganization } from "@/lib/organizations";

const registerSchema = z
  .object({
    name: z.string().min(2, "Name must be at least 2 characters").max(80),
    email: z.string().email("Enter a valid email"),
    password: z.string().min(8, "Password must be at least 8 characters"),
    // Omitted/absent = ATTENDEE, matching the page's own default when a
    // caller skips the path-choice step entirely (e.g. an older client).
    accountType: z.enum(["ATTENDEE", "ORGANISER"]).optional().default("ATTENDEE"),
    organizationName: z.string().min(1).max(120).optional(),
  })
  .superRefine((val, ctx) => {
    if (val.accountType === "ORGANISER" && !val.organizationName?.trim()) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["organizationName"],
        message: "Organisation name is required.",
      });
    }
  });

export async function POST(request: Request) {
  const { allowed } = await checkRateLimit(`register:${clientIp(request)}`, {
    limit: 5,
    windowMs: 10 * 60 * 1000,
  });
  if (!allowed) {
    return NextResponse.json(
      { error: "Too many attempts. Try again in a few minutes." },
      { status: 429 }
    );
  }

  const body = await request.json().catch(() => null);
  const parsed = registerSchema.safeParse(body);

  if (!parsed.success) {
    const message = parsed.error.issues[0]?.message ?? "Invalid input";
    return NextResponse.json({ error: message }, { status: 400 });
  }

  const { name, email, password, accountType, organizationName } = parsed.data;

  const existing = await prisma.user.findUnique({ where: { email } });
  if (existing) {
    return NextResponse.json(
      { error: "An account with that email already exists" },
      { status: 409 }
    );
  }

  const passwordHash = await bcrypt.hash(password, 10);
  const user = await prisma.$transaction(async (tx) => {
    const created = await tx.user.create({
      data: { name, email, passwordHash },
      select: { id: true, name: true, email: true },
    });
    await createPersonalOrganization(tx, created.id, created.name, {
      isAttendeeOrg: accountType === "ATTENDEE",
      organizationName: accountType === "ORGANISER" ? organizationName : undefined,
    });
    return created;
  });

  return NextResponse.json({ user }, { status: 201 });
}
