import type { Page } from "@playwright/test";
import { expect } from "@playwright/test";

// src/app/login/page.tsx
export class LoginPage {
  constructor(private readonly page: Page) {}

  async goto(callbackUrl?: string) {
    await this.page.goto(callbackUrl ? `/login?callbackUrl=${encodeURIComponent(callbackUrl)}` : "/login");
  }

  async login(email: string, password: string) {
    // /login now defaults to a phone-OTP form for the Attendee tab (see
    // src/app/login/page.tsx) — the email/password form is hidden behind
    // this toggle in that case. The Organiser tab shows the form directly,
    // so only click the toggle when #email isn't already visible; this
    // works for both organizer and fan logins without needing to know
    // which tab is active.
    const emailField = this.page.locator("#email");
    if (!(await emailField.isVisible().catch(() => false))) {
      await this.page.getByRole("button", { name: "Have a password? Log in with email instead" }).click();
    }
    await emailField.fill(email);
    await this.page.locator("#password").fill(password);
    // exact: true — otherwise this also matches the submit form's own
    // "Log in with a phone code instead" toggle button, a substring match.
    await this.page.getByRole("button", { name: "Log in", exact: true }).click();
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
