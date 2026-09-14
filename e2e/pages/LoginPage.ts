import type { Page } from "@playwright/test";
import { expect } from "@playwright/test";

// src/app/login/page.tsx
export class LoginPage {
  constructor(private readonly page: Page) {}

  async goto(callbackUrl?: string) {
    await this.page.goto(callbackUrl ? `/login?callbackUrl=${encodeURIComponent(callbackUrl)}` : "/login");
  }

  async login(email: string, password: string) {
    await this.page.locator("#email").fill(email);
    await this.page.locator("#password").fill(password);
    await this.page.getByRole("button", { name: "Log in" }).click();
  }

  /** Logs in and waits for the post-login redirect to land. */
  async loginAndWait(email: string, password: string, expectedUrlPattern: RegExp) {
    await this.login(email, password);
    await this.page.waitForURL(expectedUrlPattern);
  }

  async expectError() {
    await expect(this.page.getByText("Invalid email or password.")).toBeVisible();
  }
}
