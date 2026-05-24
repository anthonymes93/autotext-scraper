import "./config/env.js";
import cron from "node-cron";
import { runScraper, ScraperBlockedError } from "./scraper/kijiji.js";
import { processListing } from "./services/leadDecision.js";
import { createOpportunity, upsertContact, updateListingStatus } from "./services/firestore.js";
import { addLeadToNotion } from "./services/notion.js";
import { logger } from "./utils/logger.js";
import type { PipelineResult } from "./types/lead.js";

// TODO: Add scraper health monitoring — alert via email/Slack if job fails or produces 0 leads

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
  logger.info("Pipeline starting");

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

    if (result.status === "skipped") {
      stats.skipped++;
      logger.info("Lead skipped", { url: result.url, reason: result.skipReason });
      if (listing.listingId) {
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

      await Promise.all([
        createOpportunity(result.lead),
        upsertContact(result.lead),
        addLeadToNotion(result.lead),
      ]);

      if (listing.listingId) {
        await updateListingStatus(listing.listingId, "processed");
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
  // Runs daily at 8:00 AM UTC
  cron.schedule("0 8 * * *", async () => {
    logger.info("Cron job triggered");
    try {
      await runPipeline();
    } catch (err) {
      logger.error("Pipeline crashed", { err: String(err) });
    }
  });

  logger.info("Scheduler started — pipeline will run daily at 08:00 UTC");
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);

  if (args.includes("--run-now")) {
    logger.info("Running pipeline immediately (--run-now flag)");
    await runPipeline();
    process.exit(0);
  }

  startScheduler();
}

main().catch((err) => {
  logger.error("Fatal error in main", { err: String(err) });
  process.exit(1);
});
