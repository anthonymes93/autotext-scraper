# AutoText Scraper

Backend scraper service that crawls Kijiji contractor/home-service listings and pushes qualified leads into Firebase Firestore for the AutoText React app.

## Overview

- Scrapes the Kijiji **Skilled Trades (Canada)** category for contractor and home-service ads
- Paginates sequentially through result pages (configurable via `MAX_PAGES_PER_RUN`, default 15)
- Extracts contact info: phone numbers, websites, seller names, locations
- Deduplicates against Firestore contacts and Notion
- Uses OpenAI for ambiguous validation (names, companies, phone numbers)
- Generates personalized outreach messages
- Creates Firestore opportunity documents with 10-day expiry
- Runs on a daily cron schedule on a DigitalOcean VPS

## Kijiji Category

| | URL |
|---|---|
| Page 1 | `https://www.kijiji.ca/b-skilled-trades/canada/c76l0` |
| Page N (N ≥ 2) | `https://www.kijiji.ca/b-skilled-trades/canada/page-{N}/c76l0` |

Page 1 always uses the base URL without a `/page-1/` segment. Pagination stops early if a page returns zero listings.

## Setup

1. Copy `.env.example` to `.env` and fill in your credentials
2. Install dependencies: `npm install`
3. Install Playwright browser binaries: `npx playwright install chromium`
4. Run in dev mode: `npm run dev`
5. Build for production: `npm run build`
6. Start production build: `npm start`

## Environment Variables

| Variable | Description |
|---|---|
| `FIREBASE_PROJECT_ID` | Firebase project ID |
| `FIREBASE_CLIENT_EMAIL` | Firebase service account email |
| `FIREBASE_PRIVATE_KEY` | Firebase service account private key |
| `OPENAI_API_KEY` | OpenAI API key for validation |
| `NOTION_API_KEY` | Notion integration token (only required when `NOTION_ENABLED=true`). Accepts `secret_...` (classic) or `ntn_...` (modern) format. |
| `NOTION_DATABASE_ID` | Notion database ID for leads (only required when `NOTION_ENABLED=true`) |
| `NOTION_ENABLED` | `true` to enable Notion duplicate checks and lead writes (default: `false`) |
| `NOTION_PHONE_PROPERTY` | Notion database property name for phone numbers (default: `Phone`). Must be a **Phone Number** type property. Phone values must be stored in E.164 format (`+1XXXXXXXXXX`) for duplicate detection to work reliably. |
| `MAX_PAGES_PER_RUN` | Pages to scrape per run (default: `15`) |
| `SCRAPE_WINDOW_MINUTES` | Minutes to spread page fetches across (default: `120`) |
| `LIVE_MAX_LISTINGS_PER_RUN` | Max detail pages to visit per production run (default: unlimited). No effect in `TEST_MODE`. |
| `TEST_MODE` | `true` to run in safe local test mode — no credentials required (default: `false`) |
| `TEST_MAX_PAGES` | Pages to scrape in test mode (default: `1`) |
| `TEST_MAX_LISTINGS` | Listings to process in test mode (default: `3`) |
| `TEST_WRITE_TO_FIRESTORE` | Allow Firestore/Notion writes during test mode (default: `false`) |
| `RUN_IMMEDIATELY` | Run the pipeline once on startup, then keep the cron scheduler running (default: `false`) |

## Architecture

```
src/
  index.ts          # Entry point, cron scheduler
  config/
    env.ts          # Validated env vars via Zod
  scraper/
    kijiji.ts       # Fetch search pages + listing pages
  parsers/
    phone.ts        # Extract + normalize Canadian phone numbers
    website.ts      # Extract website URLs from text/sidebar
    names.ts        # Extract first name / company name
  services/
    firestore.ts    # Read/write contacts + opportunities
    notion.ts       # Duplicate check + lead write
    openai.ts       # AI validation calls
    leadDecision.ts # Pipeline: decide qualify/skip, build payload
  utils/
    delay.ts        # Randomized async delay
    logger.ts       # Structured console logger
    normalize.ts    # Phone/text normalization helpers
  types/
    lead.ts         # TypeScript types and Zod schemas
```

## Firestore Collections

| Collection | Document ID | Purpose |
|---|---|---|
| `scrapedListings` | Kijiji listing ID (numeric) | Per-listing dedupe across runs — fields: `listingId`, `listingUrl`, `firstSeenAt`, `lastSeenAt`, `timesSeen`, `source`, `status` |
| `contacts` | Auto ID | Phone-level dedupe + contact records |
| `opportunities` | Auto ID | Qualified leads ready for outreach |

`scrapedListings` status lifecycle: `seen` → `processed` (lead created) or `skipped` (no phone / has website / duplicate / AI rejected).

## Lead Pipeline

1. Paginate through the Skilled Trades category (up to `MAX_PAGES_PER_RUN` pages, stop early on empty page)
2. Deduplicate listing URLs collected across all pages
3. For each URL: check `scrapedListings/{listingId}` — skip if already exists from a prior run
3. Visit listing pages with randomized delays
4. Extract title, seller name, location, description, website, phone
5. Skip ads with an existing website
6. Normalize phone to E.164, deduplicate via Firestore then Notion
7. Validate ambiguous data with OpenAI
8. Generate outreach message
9. Write Firestore opportunity (`status: "ready"`, expires in 10 days)
10. Upsert Firestore contact record

## Startup Modes

| Mode | How | Behaviour |
|---|---|---|
| Scheduled-only (default) | `npm start` | Waits for the daily 08:00 UTC cron trigger |
| Immediate + scheduled | `RUN_IMMEDIATELY=true npm start` | Runs the pipeline once on boot, then keeps the scheduler alive for subsequent daily runs |
| One-shot (CI / manual) | `npm start -- --run-now` | Runs the pipeline once and exits |
| Test (local dev) | `TEST_MODE=true npm run dev` | See Test Mode section below |

## Test Mode

Run a safe local scrape without any Firebase, Notion, or OpenAI credentials:

```bash
TEST_MODE=true npm run dev
# or
TEST_MODE=true TEST_MAX_PAGES=1 TEST_MAX_LISTINGS=5 npm run dev
```

**What test mode does:**
- Scrapes `TEST_MAX_PAGES` pages (default 1) with 1–3 s delays instead of the full window
- Visits up to `TEST_MAX_LISTINGS` detail pages (default 3) — already-seen listings are NOT skipped so you can re-run on the same ads
- Runs the full extraction and decision pipeline (website detection, phone selection, name extraction, message generation)
- Skips Firestore/Notion dedup reads so the pipeline always reaches the message-generation step
- Skips all writes (Firestore, Notion, `scrapedListings`) unless `TEST_WRITE_TO_FIRESTORE=true`
- Logs verbose `[TEST]` lines for every listing: extracted fields, phone metadata, skip reason or generated message

**To allow writes in test mode** (requires real credentials in `.env`):
```bash
TEST_MODE=true TEST_WRITE_TO_FIRESTORE=true npm run dev
```

## Scrape Timing

The scraper runs in two sequential phases:

**Phase 1 — Page collection** (window-spread)
- Pages are fetched one at a time with a delay of `SCRAPE_WINDOW_MINUTES / MAX_PAGES_PER_RUN` between each, ±25% random jitter.
- Example: 15 pages, 120-minute window → ~8 min base delay → actual range 6–10 min per page.
- Stops early if a page returns zero listings.

**Phase 2 — Listing detail scrape** (fixed small delay)
- Each listing detail page is visited with a 10–30 second randomized delay.
- Already-seen listings (from prior runs) are skipped entirely before any HTTP request.

**Rate-limit / block detection**
- HTTP 429, 403, 503, or CAPTCHA content causes an immediate stop with a `[SCRAPER HEALTH]` warning logged.
- The run aborts and retries on the next scheduled cron invocation. Delays are never reduced on errors.

## Phone Reveal

Kijiji hides phone numbers behind a JavaScript-triggered button. The scraper uses a hybrid approach:

- **Axios + Cheerio** (default): fetches and parses every listing detail page statically
- **Playwright** (fallback): launched only when the static HTML contains a "Show phone number" button and no phone was found in the description text

Playwright opens a headless Chromium instance, clicks the reveal button, waits for a `tel:` link to appear, and extracts the number. The browser is closed immediately after. To minimize detection risk, Playwright is launched at most once per listing and only when a reveal button is confirmed in the static HTML.

**Playwright browser binaries must be installed separately after `npm install`:**

```bash
npx playwright install chromium
```

On the VPS, run this once after deploying. Chromium is not bundled with the `playwright` npm package.

## TODOs

- Proxy support for IP rotation
- Scraper health monitoring — alert via email/Slack if job is blocked or produces 0 leads
