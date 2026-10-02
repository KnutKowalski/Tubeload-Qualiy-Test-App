import type { Page } from "playwright-core";
import type { ConsentMode } from "./types";

export async function acceptConsent(
  page: Page,
  mode: ConsentMode = "reject"
): Promise<void> {
  if (mode === "none") return;

  const rejectSelectors = [
    'button[aria-label*="Reject" i]',
    'button:has-text("Alles ablehnen")',
    'button:has-text("Reject all")',
    'form[action*="consent"] button:has-text("Reject")',
  ];

  const acceptSelectors = [
    'button[aria-label*="Accept" i]',
    'button:has-text("Alle akzeptieren")',
    'button:has-text("Accept all")',
    'form[action*="consent"] button[type="submit"]',
  ];

  const selectors =
    mode === "accept"
      ? acceptSelectors
      : [...rejectSelectors, ...acceptSelectors];

  for (const sel of selectors) {
    try {
      await page.locator(sel).first().click({ timeout: 1200 });
      return;
    } catch {
      // weiter versuchen
    }
  }
}
