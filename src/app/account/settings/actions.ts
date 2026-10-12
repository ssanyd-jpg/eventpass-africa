"use server";

import { z } from "zod";
import bcrypt from "bcryptjs";
import { revalidatePath } from "next/cache";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { deleteOwnAccount } from "@/lib/account-deletion";

async function requireSelf() {
  const session = await auth();
  if (!session?.user?.id) {
    throw new Error("Forbidden");
  }
  return session;
}

// Thrown Errors (the safety-gate block, or "Account not found") propagate to
// the client component's try/catch around this call — same direct-call
// pattern as /account/sessions, just invoked from an onClick instead of a
// <form action> so the message can be shown inline instead of hitting an
// error boundary.
export async function deleteAccount() {
  const session = await requireSelf();
  await deleteOwnAccount(session.user.id);
}

const profileSchema = z.object({
  name: z.string().trim().min(2, "Name must be at least 2 characters").max(80),
  phone: z.string().trim().max(32).optional(),
});

// Email is deliberately not editable here — it doubles as the credentials
// login identifier, and changing it without a verification step would let a
// hijacked session silently lock the real owner out. Name/phone carry no
// such risk.
export async function updateProfile(input: { name: string; phone: string }) {
  const session = await requireSelf();
  const parsed = profileSchema.safeParse(input);
  if (!parsed.success) {
    throw new Error(parsed.error.issues[0]?.message ?? "Invalid input");
  }
  try {
    await prisma.user.update({
      where: { id: session.user.id },
      data: { name: parsed.data.name, phone: parsed.data.phone || null },
    });
  } catch (err: any) {
    // phone is unique (it also doubles as the phone-OTP sign-in key — see
    // auth.ts) — unlike sync-handlers.ts's opportunistic capture, this is
    // the user explicitly choosing this number, so a conflict here must
    // surface as a real error, not be swallowed.
    if (err?.code === "P2002") {
      throw new Error("That phone number is already associated with another account.");
    }
    throw err;
  }
  revalidatePath("/account/settings");
}

const passwordSchema = z.object({
  currentPassword: z.string().min(1, "Enter your current password"),
  newPassword: z.string().min(8, "New password must be at least 8 characters"),
});

export async function changePassword(input: { currentPassword: string; newPassword: string }) {
  const session = await requireSelf();
  const parsed = passwordSchema.safeParse(input);
  if (!parsed.success) {
    throw new Error(parsed.error.issues[0]?.message ?? "Invalid input");
  }

  const user = await prisma.user.findUnique({
    where: { id: session.user.id },
    select: { passwordHash: true },
  });
  if (!user) throw new Error("Account not found");
  // A phone-OTP account (see auth.ts's "buyer-otp" provider) has no
  // password at all yet — no "set initial password" flow exists, that's
  // out of scope here; just fail cleanly instead of crashing on a null
  // bcrypt.compare argument.
  if (!user.passwordHash) throw new Error("This account has no password set yet — contact support.");

  const valid = await bcrypt.compare(parsed.data.currentPassword, user.passwordHash);
  if (!valid) throw new Error("Current password is incorrect");

  const passwordHash = await bcrypt.hash(parsed.data.newPassword, 10);
  await prisma.user.update({ where: { id: session.user.id }, data: { passwordHash } });
}
