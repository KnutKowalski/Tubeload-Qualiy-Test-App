import type { Page } from "playwright-core";
import type { ConsentMode } from "./types";

export type ConsentResult =
  | "not_present"
  | "clicked"
  | "cookie_fallback"
  | "failed";

const REJECT_SELECTORS = [
  'button[aria-label*="Alle ablehnen" i]',
  'button[aria-label*="Reject all" i]',
  'button:has-text("Alle ablehnen")',
  'button:has-text("Reject all")',
  'form[action*="consent"] button:has-text("ablehnen")',
  'form[action*="consent"] button:has-text("reject")',
];

const ACCEPT_SELECTORS = [
  'button[aria-label*="Alle akzeptieren" i]',
  'button[aria-label*="Accept all" i]',
  'button:has-text("Alle akzeptieren")',
  'button:has-text("Accept all")',
  'form[action*="consent"] button:has-text("akzeptieren")',
  'form[action*="consent"] button:has-text("accept")',
];

/**
 * Prueft, ob gerade eine YouTube-/Google-Consent-Wand sichtbar ist.
 * Deckt drei Varianten ab:
 *  1. Weiterleitung auf consent.youtube.com (ganze Seite),
 *  2. Inline-Formular mit action*="consent",
 *  3. Dialog-Buttons "Alle akzeptieren"/"Alle ablehnen" (DE/EN).
 */
async function consentVisible(page: Page): Promise<boolean> {
  return page
    .evaluate(() => {
      if (location.hostname.startsWith("consent.")) return true;

      if (document.querySelector('form[action*="consent"]')) return true;

      const rx = /alle ablehnen|alle akzeptieren|reject all|accept all/i;

      return Array.from(document.querySelectorAll("button")).some((b) => {
        const label = b.getAttribute("aria-label") ?? "";
        const text = b.textContent ?? "";
        return rx.test(label) || rx.test(text);
      });
    })
    .catch(() => false);
}

/**
 * Klickt den ersten passenden Button aus der Liste.
 * Gilt erst als erfolgreich, wenn der Dialog danach wirklich weg ist.
 */
async function clickFirst(page: Page, selectors: string[]): Promise<boolean> {
  for (const sel of selectors) {
    try {
      await page.locator(sel).first().click({ timeout: 800 });
      await page.waitForTimeout(1200);

      if (!(await consentVisible(page))) return true;
    } catch {
      // naechster Selektor
    }
  }

  return false;
}

/**
 * Setzt die Consent-Cookies (SOCS/CONSENT) direkt im Browser-Kontext —
 * der Zustand, den YouTube nach dem Abnicken selbst setzen wuerde.
 */
async function setConsentCookies(page: Page): Promise<void> {
  const socs = "CAE";
  const consent = "YES+cb.20210328-17-p0.en+FX+419";

  await page
    .context()
    .addCookies([
      { name: "SOCS", value: socs, domain: ".youtube.com", path: "/" },
      { name: "CONSENT", value: consent, domain: ".youtube.com", path: "/" },
      { name: "SOCS", value: socs, domain: ".google.com", path: "/" },
      { name: "CONSENT", value: consent, domain: ".google.com", path: "/" },
    ])
    .catch(() => {});
}

/**
 * Sorgt dafuer, dass keine Consent-Wand die Wiedergabe blockiert.
 *
 * Ablauf:
 *  1. Kein Dialog sichtbar -> nichts tun.
 *  2. Bevorzugten Button klicken (mode), sonst den jeweils anderen —
 *     Hauptsache, der Dialog ist weg und das Video laeuft an.
 *  3. Klick schlaegt fehl -> Consent-Cookies setzen und neu laden.
 */
export async function acceptConsent(
  page: Page,
  mode: ConsentMode = "reject"
): Promise<ConsentResult> {
  if (mode === "none") return "not_present";

  if (!(await consentVisible(page))) return "not_present";

  const primary = mode === "accept" ? ACCEPT_SELECTORS : REJECT_SELECTORS;
  const secondary = mode === "accept" ? REJECT_SELECTORS : ACCEPT_SELECTORS;

  if (await clickFirst(page, [...primary, ...secondary])) {
    return "clicked";
  }

  await setConsentCookies(page);

  await page
    .reload({ waitUntil: "domcontentloaded", timeout: 60000 })
    .catch(() => {});

  if (!(await consentVisible(page))) return "cookie_fallback";

  return "failed";
}
