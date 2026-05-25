import "./config/env.js";
import cron from "node-cron";
import { runScraper, ScraperBlockedError } from "./scraper/kijiji.js";
import { processListing } from "./services/leadDecision.js";
import { createOpportunity, upsertContact, updateListingStatus } from "./services/firestore.js";
import { addLeadToNotion, phoneExistsInNotion } from "./services/notion.js";
import { detectWebsite } from "./parsers/website.js";
import { logger } from "./utils/logger.js";
import { env } from "./config/env.js";
import type { RawListing, PipelineResult } from "./types/lead.js";

// TODO: Add scraper health monitoring — alert via email/Slack if job fails or produces 0 leads

// ─── Test-mode verbose logging ────────────────────────────────────────────────

function logTestDecisionSummary(listing: RawListing, result: PipelineResult): void {
  const website = detectWebsite(listing.sidebarWebsite, listing.descriptionWebsites);

  const allPhoneNumbers = [
    ...listing.descriptionPhones,
    ...(listing.revealedPhone ? [listing.revealedPhone] : []),
  ];

  const primaryPhone =
    result.status === "created"
      ? result.phone
      : result.status === "skipped"
        ? (result.phone ?? null)
        : null;

  const phoneSelectionReason =
    result.status === "created" ? result.lead.phoneSelectionReason : null;

  const firstName =
    result.status === "created"
      ? result.lead.firstName
      : (listing.firstName ?? null);

  const companyName =
    result.status === "created"
      ? result.lead.companyName
      : (listing.companyName ?? null);

  const outreachMessage =
    result.status === "created" ? result.lead.outreachMessage : null;

  const skipReason =
    result.status === "skipped" ? result.skipReason : null;

  logger.info("[TEST] Decision summary", {
    title: listing.title,
    listingUrl: listing.url,
    location: listing.location ?? null,
    phoneNumbers: allPhoneNumbers,
    primaryPhone,
    phoneSelectionReason,
    websiteDetected: !!website,
    websiteUrl: website?.url ?? null,
    websiteFoundIn: website?.foundIn ?? null,
    firstName,
    companyName,
    decision: result.status,
    skipReason,
    outreachMessage,
  });
}

// ─── Stats ───────────────────────────────────────────────────────────────────

interface RunStats {
  total: number;
  scraped: number;
  created: number;
  skipped: number;
  errors: number;
  alreadySeen: number;
  revealButtonUsed: number;
  websiteDetected: number;
}

async function runPipeline(): Promise<void> {
  if (env.TEST_MODE) {
    logger.info(
      "[TEST MODE] ────────────────────────────────────────────────────────────"
    );
    logger.info("[TEST MODE] Scraping with limited pages and listings", {
      maxPages: env.TEST_MAX_PAGES,
      maxListings: env.TEST_MAX_LISTINGS,
      writeToFirestore: env.TEST_WRITE_TO_FIRESTORE,
    });
    logger.info(
      "[TEST MODE] Firestore/Notion dedup and writes are DISABLED unless TEST_WRITE_TO_FIRESTORE=true"
    );
    logger.info(
      "[TEST MODE] ────────────────────────────────────────────────────────────"
    );
  } else {
    logger.info("Pipeline starting");
  }

  const stats: RunStats = {
    total: 0,
    scraped: 0,
    created: 0,
    skipped: 0,
    errors: 0,
    alreadySeen: 0,
    revealButtonUsed: 0,
    websiteDetected: 0,
  };

  let listings: Awaited<ReturnType<typeof runScraper>>;
  try {
    listings = await runScraper();
  } catch (err) {
    if (err instanceof ScraperBlockedError) {
      logger.warn("[SCRAPER HEALTH] Run aborted: Kijiji rate-limiting or CAPTCHA detected. Will retry on next scheduled run.", {
        detail: String(err),
      });
      return;
    }
    throw err;
  }
  stats.scraped = listings.length;

  for (const listing of listings) {
    stats.total++;

    if (listing.sidebarWebsite || listing.descriptionWebsites.length > 0) {
      stats.websiteDetected++;
    }

    if (listing.revealedPhone) {
      stats.revealButtonUsed++;
    }

    let result: PipelineResult;

    try {
      result = await processListing(listing);
    } catch (err) {
      logger.error("Error processing listing", { url: listing.url, err: String(err) });
      stats.errors++;
      continue;
    }

    if (env.TEST_MODE) {
      logTestDecisionSummary(listing, result);
    }

    if (result.status === "skipped") {
      stats.skipped++;
      logger.info("Lead skipped", { url: result.url, reason: result.skipReason });
      if (!env.TEST_MODE && listing.listingId) {
        await updateListingStatus(listing.listingId, "skipped");
      }
      continue;
    }

    if (result.status === "error") {
      stats.errors++;
      logger.error("Lead pipeline error", { url: result.url, error: result.error });
      continue;
    }

    if (result.status === "created") {
      stats.created++;

      // Defensive guard: re-check Notion immediately before writing, in case the
      // pipeline check was skipped due to a transient error or config change.
      if (env.NOTION_ENABLED && !env.TEST_MODE) {
        const notionDupe = await phoneExistsInNotion(result.phone);
        if (notionDupe) {
          logger.warn("Blocked opportunity creation: duplicate_notion", {
            phone: result.phone,
            listingUrl: result.url,
          });
          stats.skipped++;
          continue;
        }
      }

      if (env.TEST_MODE && !env.TEST_WRITE_TO_FIRESTORE) {
        logger.info("[TEST] Skipping Firestore/Notion writes (TEST_WRITE_TO_FIRESTORE not set)", {
          url: result.url,
          phone: result.phone,
        });
      } else {
        const writes: Promise<unknown>[] = [
          createOpportunity(result.lead),
          upsertContact(result.lead),
        ];

        if (env.NOTION_ENABLED && env.NOTION_WRITE_ENABLED) {
          writes.push(addLeadToNotion(result.lead));
        } else {
          const reason = !env.NOTION_ENABLED ? "Notion disabled" : "Notion write disabled";
          logger.info(`${reason}, skipping addLeadToNotion`, { url: result.url });
        }

        await Promise.all(writes);

        if (!env.TEST_MODE && listing.listingId) {
          await updateListingStatus(listing.listingId, "processed");
        }
      }

      logger.info("Lead created", { phone: result.phone, url: result.url });
    }
  }

  logger.info("Pipeline complete", {
    scraped: stats.scraped,
    alreadySeen: stats.alreadySeen,
    created: stats.created,
    skipped: stats.skipped,
    errors: stats.errors,
    revealButtonUsed: stats.revealButtonUsed,
    websiteDetected: stats.websiteDetected,
  });
}

function startScheduler(): void {
  // Runs daily at 18:00 UTC
  cron.schedule("0 18 * * *", async () => {
    logger.info("Cron job triggered");
    try {
      await runPipeline();
    } catch (err) {
      logger.error("Pipeline crashed", { err: String(err) });
    }
  });

  logger.info("Scheduler started - pipeline will run daily at 18:00 UTC");
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);

  // --run-now: one-shot run, then exit (CI / manual trigger).
  if (args.includes("--run-now")) {
    logger.info("Startup mode: one-shot (--run-now flag)");
    await runPipeline();
    process.exit(0);
  }

  if (env.RUN_IMMEDIATELY) {
    // Run now AND keep the scheduler alive for subsequent daily runs.
    logger.info("Startup mode: immediate-run + scheduler (RUN_IMMEDIATELY=true)");
    startScheduler();
    logger.info("Running pipeline immediately on startup");
    try {
      await runPipeline();
    } catch (err) {
      // Log but don't exit — the scheduler should still keep running.
      logger.error("Immediate startup run failed", { err: String(err) });
    }
    return;
  }

  logger.info("Startup mode: scheduled-only - pipeline will run daily at 18:00 UTC");
  startScheduler();
}

main().catch((err) => {
  logger.error("Fatal error in main", { err: String(err) });
  process.exit(1);
});
