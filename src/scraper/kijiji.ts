import fs from "fs";
import path from "path";
import axios from "axios";
import * as cheerio from "cheerio";

type CheerioAPI = ReturnType<typeof cheerio.load>;
import { sleep, pageDelay, computePageDelayMs, shortDelay } from "../utils/delay.js";
import { logger } from "../utils/logger.js";
import { env } from "../config/env.js";
import { extractListingId, listingAlreadySeen, markListingSeen } from "../services/firestore.js";
import { extractPhonesFromText } from "../parsers/phone.js";
import { revealPhoneWithPlaywright, REVEAL_BUTTON_SELECTORS } from "./playwrightReveal.js";
import { extractWebsitesFromText } from "../parsers/website.js";
import { extractFirstName, extractCompanyName } from "../parsers/names.js";
import { normalizeWhitespace } from "../utils/normalize.js";
import type { RawListing } from "../types/lead.js";

// TODO: Add proxy support — rotate IPs to avoid rate-limiting and bans

export class ScraperBlockedError extends Error {
  constructor(detail: string) {
    super(`Scraper blocked: ${detail}`);
    this.name = "ScraperBlockedError";
  }
}

const BASE_URL = "https://www.kijiji.ca/b-skilled-trades/canada/c76l0";
const PAGE_URL = (page: number) =>
  `https://www.kijiji.ca/b-skilled-trades/canada/page-${page}/c76l0`;

function buildPageUrl(page: number): string {
  return page === 1 ? BASE_URL : PAGE_URL(page);
}

const HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
  "Accept-Language": "en-CA,en;q=0.9",
  Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8",
};

// Signals in the first ~2 KB of HTML that indicate Kijiji/Imperva bot blocking.
const BLOCK_SIGNALS = [
  "robot check",
  "_incapsula_resource",
  "access denied",
  "verify you are human",
  "captcha-delivery",
  "please verify you",
];

function isBlockedContent(html: string): boolean {
  const head = html.slice(0, 2000).toLowerCase();
  return BLOCK_SIGNALS.some((signal) => head.includes(signal));
}

async function fetchHtml(url: string): Promise<string | null> {
  try {
    const response = await axios.get<string>(url, {
      headers: HEADERS,
      timeout: 15000,
      validateStatus: () => true, // Inspect status manually; never let Axios throw on HTTP errors.
    });

    if (response.status === 429 || response.status === 403 || response.status === 503) {
      throw new ScraperBlockedError(`HTTP ${response.status} from ${url}`);
    }

    if (response.status >= 400) {
      logger.error("HTTP error fetching URL", { url, status: response.status });
      return null;
    }

    if (isBlockedContent(response.data)) {
      throw new ScraperBlockedError(`Block/CAPTCHA page detected at ${url}`);
    }

    return response.data;
  } catch (err) {
    if (err instanceof ScraperBlockedError) throw err;
    logger.error("Failed to fetch URL", { url, err: String(err) });
    return null;
  }
}

// Matches Kijiji listing detail URLs:
//   /v-{category}/{location}/{slug}/{7+digit-id}
//   /b-{category}/{location}/{7+digit-id}
// Excludes browse/category pages that end with c{n}l{n} codes.
const LISTING_URL_RE = /\/[vb]-[^/]+.*\/(\d{7,})(?:[?#].*)?$/;

function isKijijiListingUrl(url: string): boolean {
  return url.includes("kijiji.ca") && LISTING_URL_RE.test(url);
}

function toAbsolute(href: string): string {
  if (href.startsWith("http")) return href;
  return `https://www.kijiji.ca${href}`;
}

function saveDebugHtml(html: string, filename: string): void {
  try {
    const dir = path.join(process.cwd(), "debug");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, filename), html, "utf8");
    logger.debug("[TEST] Saved debug HTML", { file: path.join("debug", filename) });
  } catch (err) {
    logger.warn("[TEST] Failed to save debug HTML", { err: String(err) });
  }
}

async function extractListingUrls(searchUrl: string, pageNum: number = 1): Promise<string[]> {
  const html = await fetchHtml(searchUrl);
  if (!html) return [];

  if (env.TEST_MODE) {
    logger.info("[TEST] Fetched search page", { url: searchUrl, htmlLength: html.length });
    saveDebugHtml(html, `kijiji-search-page${pageNum > 1 ? `-${pageNum}` : ""}.html`);
  }

  const $ = cheerio.load(html);
  const allAnchors = $("a[href]");

  logger.debug("Scanning anchors for listing URLs", {
    totalAnchors: allAnchors.length,
    searchUrl,
  });

  const candidates: string[] = [];
  allAnchors.each((_, el) => {
    const href = $(el).attr("href");
    if (!href) return;
    const absolute = toAbsolute(href);
    if (isKijijiListingUrl(absolute)) {
      candidates.push(absolute);
    }
  });

  logger.debug("Candidate listing URLs found", { candidates: candidates.length, searchUrl });

  const unique = [...new Set(candidates)];

  logger.info("Found listing URLs on search page", {
    totalAnchors: allAnchors.length,
    candidates: candidates.length,
    unique: unique.length,
    searchUrl,
  });

  return unique;
}

function parseJsonLd($: CheerioAPI): Record<string, unknown> | null {
  const candidates: Record<string, unknown>[] = [];
  $('script[type="application/ld+json"]').each((_, el) => {
    try {
      const raw = $( el).html() ?? "";
      const parsed: unknown = JSON.parse(raw);
      const obj = Array.isArray(parsed) ? parsed[0] : parsed;
      if (obj && typeof obj === "object") {
        candidates.push(obj as Record<string, unknown>);
      }
    } catch {
      // ignore malformed JSON-LD
    }
  });
  return candidates.find((o) => "name" in o) ?? candidates[0] ?? null;
}

// Extracts the seller profile URL from Kijiji's embedded __NEXT_DATA__ Apollo cache.
// Kijiji embeds full listing + profile data as server-side Apollo state on every listing page.
// Works for both FSBO sellers (StandardProfileV2 → /o-profile/<id>/1)
// and commercial/pro sellers (CommercialProfileV2 → /o-<slug>/<id>/listings/1).
// Falls back to a Cheerio href selector if JSON parsing fails.
function parseSellerProfileUrl($: CheerioAPI, listingId: string | undefined): string | null {
  try {
    const raw = $("script#__NEXT_DATA__").html() ?? "";
    if (!raw) return null;

    const nextData = JSON.parse(raw) as Record<string, unknown>;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const apollo = (nextData as any)?.props?.pageProps?.__APOLLO_STATE__;
    if (!apollo || typeof apollo !== "object") return null;

    // Resolve posterId from the listing's posterInfo for an exact match.
    let posterId: string | null = null;
    if (listingId) {
      const listingEntry = (apollo as Record<string, unknown>)[`StandardListing:${listingId}`] as Record<string, unknown> | undefined;
      const posterInfo = listingEntry?.["posterInfo"] as Record<string, unknown> | undefined;
      if (typeof posterInfo?.["posterId"] === "string" || typeof posterInfo?.["posterId"] === "number") {
        posterId = String(posterInfo["posterId"]);
      }
    }

    let profilePath: string | null = null;

    if (posterId) {
      const apolloMap = apollo as Record<string, unknown>;
      const profileEntry =
        (apolloMap[`StandardProfileV2:${posterId}`] as Record<string, unknown> | undefined) ??
        (apolloMap[`CommercialProfileV2:${posterId}`] as Record<string, unknown> | undefined);
      const pp = profileEntry?.["profilePath"];
      if (typeof pp === "string") profilePath = pp;
    }

    // Fallback: scan Apollo keys when posterId lookup misses.
    if (!profilePath) {
      for (const key of Object.keys(apollo as object)) {
        if (key.startsWith("StandardProfileV2:") || key.startsWith("CommercialProfileV2:")) {
          const pp = ((apollo as Record<string, unknown>)[key] as Record<string, unknown> | undefined)?.["profilePath"];
          if (typeof pp === "string") { profilePath = pp; break; }
        }
      }
    }

    if (profilePath) return `https://www.kijiji.ca${profilePath}`;
  } catch {
    // fall through to Cheerio fallback
  }

  // Cheerio fallback: the profile anchor is inside [data-testid="vip-about-seller"]
  // and starts with /o- for both FSBO (/o-profile/) and commercial (/o-<slug>/) profiles.
  const fallbackHref = $('[data-testid="vip-about-seller"] a[href^="/o-"]').first().attr("href");
  return fallbackHref ? `https://www.kijiji.ca${fallbackHref}` : null;
}

async function scrapeListingPage(url: string): Promise<RawListing | null> {
  const html = await fetchHtml(url);
  if (!html) return null;

  const listingId = extractListingId(url) ?? undefined;

  if (env.TEST_MODE) {
    logger.info("[TEST] Fetched listing detail page", { url, htmlLength: html.length, listingId });
    saveDebugHtml(html, `listing-${listingId ?? "unknown"}.html`);
  }

  const $ = cheerio.load(html);
  const jsonLd = parseJsonLd($);

  // ─── Title ───────────────────────────────────────────────────────────────
  let title = "";
  let titleStrategy = "";

  const h1 = normalizeWhitespace($("h1").first().text());
  if (h1) { title = h1; titleStrategy = "h1"; }

  if (!title) {
    const og = $('meta[property="og:title"]').attr("content") ?? "";
    const ogClean = normalizeWhitespace(og);
    if (ogClean) { title = ogClean; titleStrategy = "og:title"; }
  }

  if (!title) {
    const raw = $("title").first().text().replace(/\s*[-|]\s*Kijiji.*$/i, "");
    const tagClean = normalizeWhitespace(raw);
    if (tagClean) { title = tagClean; titleStrategy = "title-tag"; }
  }

  if (!title && jsonLd) {
    const ldName = typeof jsonLd["name"] === "string" ? normalizeWhitespace(jsonLd["name"]) : "";
    if (ldName) { title = ldName; titleStrategy = "json-ld.name"; }
  }

  if (title) {
    logger.debug("Title extracted", { strategy: titleStrategy, title, url });
  }

  // ─── Description ─────────────────────────────────────────────────────────
  let description = "";
  let descStrategy = "";

  const descSelectors = [
    "[class*='descriptionContainer']",
    "[data-testid*='description']",
    "#pstad-descrptn",
    "[class*='description-container']",
  ];
  for (const sel of descSelectors) {
    const text = normalizeWhitespace($(sel).first().text());
    if (text) { description = text; descStrategy = sel; break; }
  }

  if (!description) {
    const og = $('meta[property="og:description"]').attr("content") ?? "";
    const ogClean = normalizeWhitespace(og);
    if (ogClean) { description = ogClean; descStrategy = "og:description"; }
  }

  if (!description && jsonLd) {
    const ldDesc = typeof jsonLd["description"] === "string"
      ? normalizeWhitespace(jsonLd["description"])
      : "";
    if (ldDesc) { description = ldDesc; descStrategy = "json-ld.description"; }
  }

  if (description) {
    logger.debug("Description extracted", { strategy: descStrategy, length: description.length, url });
  }

  // ─── Seller name ──────────────────────────────────────────────────────────
  const sellerName =
    normalizeWhitespace(
      $("[class*='sellerName'], [class*='seller-name'], [data-testid*='seller-name']")
        .first()
        .text() || ""
    ) || undefined;

  // ─── Location ────────────────────────────────────────────────────────────
  let location: string | undefined;
  let locationStrategy = "";

  const locationSelectors = [
    "[data-testid*='location']",
    "[class*='address']",
    "[class*='location']",
  ];
  for (const sel of locationSelectors) {
    const text = normalizeWhitespace($(sel).first().text());
    if (text) { location = text; locationStrategy = sel; break; }
  }

  if (!location && jsonLd) {
    const addr = jsonLd["address"];
    if (addr && typeof addr === "object") {
      const a = addr as Record<string, unknown>;
      const city = typeof a["addressLocality"] === "string" ? a["addressLocality"] : "";
      const region = typeof a["addressRegion"] === "string" ? a["addressRegion"] : "";
      const parts = [city, region].filter(Boolean);
      if (parts.length) { location = parts.join(", "); locationStrategy = "json-ld.address"; }
    }
  }

  if (location) {
    logger.debug("Location extracted", { strategy: locationStrategy, location, url });
  }

  // ─── Website ─────────────────────────────────────────────────────────────
  const sidebarWebsiteHref = $("a[class*='websiteLink'], a[href*='website']")
    .first()
    .attr("href");
  const sidebarWebsite = sidebarWebsiteHref?.startsWith("http")
    ? sidebarWebsiteHref
    : undefined;

  const descriptionWebsites = extractWebsitesFromText(description);
  const descriptionPhones = extractPhonesFromText(description);

  let revealedPhone: string | undefined;

  // Only trigger phone reveal if no phone was found in description text.
  if (descriptionPhones.length === 0) {
    revealedPhone = await tryRevealPhone($, url);
  } else {
    logger.debug("Phone found in description, skipping reveal", { url });
  }

  if (!title) {
    logger.warn("Could not extract title from listing", { url });
    if (env.TEST_MODE) {
      const bodyPreview = normalizeWhitespace($("body").text()).slice(0, 500);
      logger.info("[TEST] Body text preview (title extraction failed)", { url, bodyPreview });
    }
    return null;
  }

  // Extract names with high confidence so leadDecision doesn't re-run parsers.
  const firstName = sellerName ? extractFirstName(sellerName) ?? undefined : undefined;
  const companyName = sellerName ? extractCompanyName(sellerName) ?? undefined : undefined;

  // ─── Seller profile URL ───────────────────────────────────────────────────
  const sellerProfileUrl = parseSellerProfileUrl($, listingId) ?? undefined;
  if (sellerProfileUrl) {
    logger.debug("Seller profile URL extracted", { sellerProfileUrl, url });
  }

  return {
    url,
    listingId,
    title,
    sellerName,
    location,
    description,
    sidebarWebsite,
    descriptionWebsites,
    descriptionPhones,
    revealedPhone,
    firstName,
    companyName,
    sellerProfileUrl,
  };
}

// Additional static selectors not covered by the shared REVEAL_BUTTON_SELECTORS list.
const STATIC_ONLY_REVEAL_SELECTORS = ["a[href*='ShowPhoneNumber']"];
const STATIC_REVEAL_TEXT_RE = /show\s+phone/i;

function hasRevealButtonInStaticHtml($: CheerioAPI): boolean {
  const allSelectors = [...REVEAL_BUTTON_SELECTORS, ...STATIC_ONLY_REVEAL_SELECTORS];
  if (allSelectors.some((sel) => $(sel).length > 0)) return true;
  return $("button, a")
    .toArray()
    .some((el) => STATIC_REVEAL_TEXT_RE.test($(el).text()));
}

async function tryRevealPhone($: CheerioAPI, url: string): Promise<string | undefined> {
  if (!hasRevealButtonInStaticHtml($)) {
    logger.debug("No phone reveal button in static HTML", { url });
    return undefined;
  }

  logger.info("Phone reveal button detected, launching Playwright", { url });

  const revealedRaw = await revealPhoneWithPlaywright(url);
  if (!revealedRaw) {
    logger.warn("Phone reveal: Playwright returned no phone text", { url });
    return undefined;
  }

  const phones = extractPhonesFromText(revealedRaw);
  if (phones.length === 0) {
    logger.warn("Phone reveal: text returned but no phone pattern matched", {
      url,
      revealedText: revealedRaw.slice(0, 100),
    });
    return undefined;
  }

  logger.info("Phone reveal success", { url, phone: phones[0] });
  return phones[0];
}

async function collectListingUrls(): Promise<string[]> {
  const seenUrls = new Set<string>();
  const isTest = env.TEST_MODE;
  const maxPages = isTest ? env.TEST_MAX_PAGES : env.MAX_PAGES_PER_RUN;
  const windowMinutes = env.SCRAPE_WINDOW_MINUTES;

  if (isTest) {
    logger.info("[TEST MODE] Page collection", { maxPages, listingCap: env.TEST_MAX_LISTINGS });
  } else {
    const basePageDelayMs = computePageDelayMs(windowMinutes, maxPages);
    const jitterRange = Math.round((basePageDelayMs * 0.25) / 1000);
    const estimatedMinutes = Math.round((basePageDelayMs * maxPages) / 60_000);
    logger.info("Starting page collection", {
      maxPages,
      windowMinutes,
      pageDelaySeconds: Math.round(basePageDelayMs / 1000),
      pageDelayJitterSeconds: `±${jitterRange}s`,
      estimatedPagePhaseMinutes: estimatedMinutes,
    });
  }

  for (let page = 1; page <= maxPages; page++) {
    const pageUrl = buildPageUrl(page);
    logger.info("Scraping search page", { page, url: pageUrl });

    const pageUrls = await extractListingUrls(pageUrl, page);

    if (pageUrls.length === 0) {
      logger.info("No listings found on page, stopping pagination early", { page });
      break;
    }

    for (const url of pageUrls) {
      seenUrls.add(url);
    }

    logger.info("Collected listing URLs", {
      page,
      pageCount: pageUrls.length,
      totalUnique: seenUrls.size,
    });

    if (page < maxPages) {
      if (isTest) {
        await shortDelay();
      } else {
        await pageDelay(windowMinutes, maxPages);
      }
    }
  }

  return [...seenUrls];
}

export async function runScraper(): Promise<RawListing[]> {
  const allListings: RawListing[] = [];
  let alreadySeenCount = 0;
  let newCount = 0;
  let visitCount = 0; // counts actual HTTP requests to detail pages
  const isTest = env.TEST_MODE;
  const listingCap = isTest
    ? env.TEST_MAX_LISTINGS
    : (env.LIVE_MAX_LISTINGS_PER_RUN ?? Infinity);
  const capDisplay = listingCap === Infinity ? "unlimited" : listingCap;
  const delayMinS = env.FAST_TEST_MODE ? 1 : env.DETAIL_DELAY_MIN_SECONDS;
  const delayMaxS = env.FAST_TEST_MODE ? 3 : env.DETAIL_DELAY_MAX_SECONDS;

  const listingUrls = await collectListingUrls();

  if (isTest) {
    logger.info("[TEST MODE] Starting detail scrape", {
      collected: listingUrls.length,
      cap: listingCap,
      fastTestMode: env.FAST_TEST_MODE,
      delayRangeSeconds: `${delayMinS}–${delayMaxS}`,
    });
  } else {
    const toVisit = listingCap === Infinity ? listingUrls.length : Math.min(listingUrls.length, listingCap);
    const avgDelayMs = ((delayMinS + delayMaxS) / 2) * 1000;
    const estimatedListingMinutes = Math.round((toVisit * avgDelayMs) / 60_000);
    logger.info("Starting listing detail scrape", {
      collected: listingUrls.length,
      liveListingCap: capDisplay,
      willVisit: toVisit,
      delayRangeSeconds: `${delayMinS}–${delayMaxS}`,
      estimatedListingPhaseMinutes: estimatedListingMinutes,
    });
  }

  for (const listingUrl of listingUrls) {
    if (visitCount >= listingCap) {
      logger.info("Live listing cap reached, stopping detail scrape", {
        visited: visitCount,
        cap: listingCap,
      });
      break;
    }

    const listingId = extractListingId(listingUrl);

    // In test mode: always visit the page so extraction logic can be observed.
    if (!isTest && listingId) {
      const seen = await listingAlreadySeen(listingId);
      if (seen) {
        alreadySeenCount++;
        logger.debug("Skipping already-seen listing", { listingId, url: listingUrl });
        continue;
      }
    }

    // Apply delay before every visit except the first.
    if (visitCount > 0) {
      const delaySecs = Math.round(delayMinS + Math.random() * (delayMaxS - delayMinS));
      logger.info("Waiting before next listing detail page", {
        delaySeconds: delaySecs,
        listing: visitCount + 1,
        of: capDisplay,
      });
      await sleep(delaySecs * 1000);
    }

    visitCount++;
    logger.debug("Visiting listing", { url: listingUrl, testMode: isTest });
    const listing = await scrapeListingPage(listingUrl);

    if (listing) {
      newCount++;
      allListings.push(listing);
      logger.info("Scraped listing", { url: listingUrl, title: listing.title });

      // Only mark seen in production so test runs don't pollute scrapedListings.
      if (!isTest && listingId) {
        await markListingSeen(listingId, listingUrl);
      }
    }
  }

  logger.info("Detail scrape complete", {
    collected: listingUrls.length,
    alreadySeen: alreadySeenCount,
    visited: visitCount,
    newlyScraped: newCount,
  });

  return allListings;
}
