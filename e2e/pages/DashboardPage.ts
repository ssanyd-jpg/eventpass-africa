import type { Page } from "@playwright/test";
import { expect } from "@playwright/test";

// src/app/dashboard/page.tsx — the organizer's own Dexie-backed dashboard.
// Data only appears once the local IndexedDB cache has synced from the
// server (see the "offline-first" note in e2e/README.md), so callers should
// expect first paint to lag behind navigation.
export class DashboardPage {
  constructor(private readonly page: Page) {}

  async goto() {
    await this.page.goto("/dashboard");
  }

  async expectLoaded() {
    await expect(this.page.getByRole("heading", { name: "Your events" })).toBeVisible();
  }

  eventRow(eventTitle: string) {
    return this.page.locator(".card", { hasText: eventTitle });
  }

  async openManage(eventTitle: string) {
    await this.eventRow(eventTitle).getByRole("link", { name: "Manage" }).click();
  }

  async openScanGate(eventTitle: string) {
    await this.eventRow(eventTitle).getByRole("link", { name: "Scan gate" }).click();
  }

  async signOut() {
    await this.page.getByRole("button", { name: "Sign out" }).click();
  }
}
