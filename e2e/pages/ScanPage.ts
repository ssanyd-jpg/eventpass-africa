import type { Page } from "@playwright/test";
import { expect } from "@playwright/test";

// src/app/scan/[eventId]/page.tsx — the gate scanner. Camera/NFC widgets
// aren't usable under Playwright (no real camera/Web NFC in headless
// Chromium), so this only ever drives the manual code entry + submit form.
export class ScanPage {
  constructor(private readonly page: Page) {}

  async goto(eventId: string) {
    await this.page.goto(`/scan/${eventId}`);
  }

  private get codeInput() {
    return this.page.getByPlaceholder("Enter or scan ticket code");
  }

  async checkIn(code: string) {
    await this.codeInput.fill(code);
    await this.page.getByRole("button", { name: "Check in", exact: true }).click();
  }

  async expectEntryGranted() {
    await expect(this.page.getByText("Entry granted.")).toBeVisible();
  }

  async expectAlreadyCheckedIn() {
    await expect(this.page.getByText("Already checked in.")).toBeVisible();
  }
}
