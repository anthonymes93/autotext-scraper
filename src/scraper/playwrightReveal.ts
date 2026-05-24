import { chromium, type Browser } from "playwright";
import { logger } from "../utils/logger.js";

const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

// Ordered list of CSS selectors tried when locating the reveal button on the live page.
export const REVEAL_BUTTON_SELECTORS = [
  "[class*='ShowPhone']",
  "[class*='showPhone']",
  "[class*='show-phone']",
  "[class*='phoneReveal']",
  "[class*='phone-reveal']",
  "button[data-testid*='phone']",
  "a[data-testid*='phone']",
];

const REVEAL_TEXT_RE = /show\s+phone/i;

// Selectors tried when extracting the revealed phone text after the button click.
const REVEALED_PHONE_SELECTORS = [
  "[class*='phoneNumber']",
  "[class*='phone-number']",
  "[class*='PhoneNumber']",
  "[data-testid*='phone-number']",
];

/**
 * Navigates to a Kijiji listing, clicks the "Show phone number" button, and
 * returns the raw phone text (e.g. "+14165551234" or "(416) 555-1234").
 * Returns undefined if the button cannot be found or the reveal fails.
 */
export async function revealPhoneWithPlaywright(url: string): Promise<string | undefined> {
  let browser: Browser | undefined;
  try {
    browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({
      userAgent: USER_AGENT,
      extraHTTPHeaders: { "Accept-Language": "en-CA,en;q=0.9" },
    });
    const page = await context.newPage();

    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30_000 });

    // ── Find and click the reveal button ────────────────────────────────────
    let clicked = false;

    for (const sel of REVEAL_BUTTON_SELECTORS) {
      const locator = page.locator(sel).first();
      if ((await locator.count()) > 0) {
        await locator.click();
        logger.debug("Playwright: clicked reveal button by selector", { url, selector: sel });
        clicked = true;
        break;
      }
    }

    if (!clicked) {
      const buttons = page.locator("button, a[role='button']");
      const count = await buttons.count();
      for (let i = 0; i < count; i++) {
        const text = await buttons.nth(i).textContent();
        if (text && REVEAL_TEXT_RE.test(text)) {
          await buttons.nth(i).click();
          logger.debug("Playwright: clicked reveal button by text", { url });
          clicked = true;
          break;
        }
      }
    }

    if (!clicked) {
      logger.debug("Playwright: reveal button not found on loaded page", { url });
      return undefined;
    }

    // ── Wait for phone to appear ─────────────────────────────────────────────
    // tel: links are the most reliable signal that reveal completed.
    try {
      await page.locator("a[href^='tel:']").first().waitFor({ timeout: 5_000 });
    } catch {
      // tel: link didn't appear in time; fall through to text selectors
    }

    // Prefer tel: href — already E.164-friendly
    const telLink = page.locator("a[href^='tel:']").first();
    if ((await telLink.count()) > 0) {
      const href = await telLink.getAttribute("href");
      if (href) return href.replace(/^tel:/i, "").trim();
    }

    // Fallback: known revealed-phone element text
    for (const sel of REVEALED_PHONE_SELECTORS) {
      const el = page.locator(sel).first();
      if ((await el.count()) > 0) {
        const text = await el.textContent();
        if (text?.trim()) return text.trim();
      }
    }

    logger.debug("Playwright: reveal clicked but no phone element found", { url });
    return undefined;
  } catch (err) {
    logger.error("Playwright reveal failed", { url, err: String(err) });
    return undefined;
  } finally {
    await browser?.close();
  }
}
