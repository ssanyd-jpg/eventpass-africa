import { describe, expect, it, vi } from "vitest";
import { prisma } from "@/lib/prisma";
import { changePassword } from "@/app/account/settings/actions";

// requireSelf() in actions.ts calls auth() directly — no existing test in
// this codebase mocks @/auth yet, this establishes the pattern: a minimal
// stand-in session, just enough for requireSelf()'s session.user.id check.
// vi.mock calls are hoisted above imports by vitest's transform, so the
// static import above still resolves against this mock.
const { mockAuth } = vi.hoisted(() => ({ mockAuth: vi.fn() }));
vi.mock("@/auth", () => ({ auth: mockAuth }));

describe("changePassword — phone-OTP (passwordHash: null) accounts", () => {
  it("fails cleanly instead of crashing on a null passwordHash", async () => {
    const otpUser = await prisma.user.create({
      data: { name: "OTP Buyer", email: `otp-settings-${Date.now()}@test.local`, passwordHash: null },
    });
    mockAuth.mockResolvedValue({ user: { id: otpUser.id } });

    await expect(
      changePassword({ currentPassword: "anything", newPassword: "newpassword123" })
    ).rejects.toThrow("This account has no password set yet — contact support.");
  });
});
