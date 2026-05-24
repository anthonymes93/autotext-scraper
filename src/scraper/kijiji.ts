import axios from "axios";
import * as cheerio from "cheerio";

type CheerioAPI = ReturnType<typeof cheerio.load>;
import { listingDelay, pageDelay, computePageDelayMs } from "../utils/delay.js";
import { logger } from "../utils/logger.js";
import { env } from "../config/env.js";
import { extractListingId, listingAlreadySeen, markListingSeen } from "../services/firestore.js";
import { extractPhonesFromText } from "../parsers/phone.js";
import { extractWebsitesFromText } from "../parsers/website.js";
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

async function extractListingUrls(searchUrl: string): Promise<string[]> {
  const html = await fetchHtml(searchUrl);
  if (!html) return [];

  const $ = cheerio.load(html);
  const urls: string[] = [];

  // TODO: Confirm these selectors against live Kijiji markup — they change periodically
  $("a[data-listing-id]").each((_, el) => {
    const href = $(el).attr("href");
    if (href) {
      const absolute = href.startsWith("http") ? href : `https://www.kijiji.ca${href}`;
      urls.push(absolute);
    }
  });

  logger.info("Found listing URLs on search page", { count: urls.length, searchUrl });
  return urls;
}

async function scrapeListingPage(url: string): Promise<RawListing | null> {
  const html = await fetchHtml(url);
  if (!html) return null;

  const $ = cheerio.load(html);

  // TODO: Verify these selectors against live Kijiji listing markup
  const title = normalizeWhitespace($("h1[class*='title']").first().text() || "");
  const sellerName =
    normalizeWhitespace(
      $("[class*='sellerName'], [class*='seller-name']").first().text() || ""
    ) || undefined;
  const location =
    normalizeWhitespace(
      $("[class*='address'], [class*='location']").first().text() || ""
    ) || undefined;
  const description = normalizeWhitespace(
    $("[class*='descriptionContainer'], #pstad-descrptn").first().text() || ""
  );

  const sidebarWebsiteHref = $("a[class*='websiteLink'], a[href*='website']")
    .first()
    .attr("href");
  const sidebarWebsite = sidebarWebsiteHref?.startsWith("http")
    ? sidebarWebsiteHref
    : undefined;

  const descriptionWebsites = extractWebsitesFromText(description);
  const descriptionPhones = extractPhonesFromText(description);

  let revealedPhone: string | undefined;

  // Only trigger phone reveal if no phone was found in description text
  if (descriptionPhones.length === 0) {
    revealedPhone = await tryRevealPhone($, url);
  } else {
    logger.debug("Phone found in description, skipping reveal", { url });
  }

  if (!title) {
    logger.warn("Could not extract title from listing", { url });
    return null;
  }

  return {
    url,
    listingId: extractListingId(url) ?? undefined,
    title,
    sellerName,
    location,
    description,
    sidebarWebsite,
    descriptionWebsites,
    descriptionPhones,
    revealedPhone,
  };
}

async function tryRevealPhone(
  $: CheerioAPI,
  url: string
): Promise<string | undefined> {
  // TODO: Implement actual phone reveal — Kijiji uses a JS-triggered API call
  // This likely requires a headless browser (Puppeteer) or reverse-engineered API endpoint
  logger.debug("Phone reveal attempted (not yet implemented)", { url });
  void $;
  return undefined;
}

async function collectListingUrls(): Promise<string[]> {
  const seenUrls = new Set<string>();
  const { MAX_PAGES_PER_RUN: maxPages, SCRAPE_WINDOW_MINUTES: windowMinutes } = env;

  const basePageDelayMs = computePageDelayMs(windowMinutes, maxPages);
  const jitterRange = Math.round(basePageDelayMs * 0.25 / 1000);
  const estimatedMinutes = Math.round((basePageDelayMs * maxPages) / 60_000);

  logger.info("Starting page collection", {
    maxPages,
    windowMinutes,
    pageDelaySeconds: Math.round(basePageDelayMs / 1000),
    pageDelayJitterSeconds: `±${jitterRange}s`,
    estimatedPagePhaseMinutes: estimatedMinutes,
  });

  for (let page = 1; page <= maxPages; page++) {
    const pageUrl = buildPageUrl(page);
    logger.info("Scraping search page", { page, url: pageUrl });

    const pageUrls = await extractListingUrls(pageUrl);

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
      await pageDelay(windowMinutes, maxPages);
    }
  }

  return [...seenUrls];
}

export async function runScraper(): Promise<RawListing[]> {
  const allListings: RawListing[] = [];
  let alreadySeenCount = 0;
  let newCount = 0;

  const listingUrls = await collectListingUrls();

  const estimatedListingMinutes = Math.round((listingUrls.length * 20_000) / 60_000);
  logger.info("Starting listing detail scrape", {
    total: listingUrls.length,
    listingDelayRangeSeconds: "10–30",
    estimatedListingPhaseMinutes: estimatedListingMinutes,
  });

  for (const listingUrl of listingUrls) {
    const listingId = extractListingId(listingUrl);

    if (listingId) {
      const seen = await listingAlreadySeen(listingId);
      if (seen) {
        alreadySeenCount++;
        logger.debug("Skipping already-seen listing", { listingId, url: listingUrl });
        continue;
      }
    }

    logger.debug("Visiting new listing", { url: listingUrl });
    const listing = await scrapeListingPage(listingUrl);

    if (listing) {
      newCount++;
      allListings.push(listing);
      logger.info("Scraped new listing", { url: listingUrl, title: listing.title });

      if (listingId) {
        await markListingSeen(listingId, listingUrl);
      }
    }

    await listingDelay();
  }

  logger.info("Detail scrape complete", {
    collected: listingUrls.length,
    alreadySeen: alreadySeenCount,
    newlyScraped: newCount,
  });

  return allListings;
}
