import { detectWebsite } from "../parsers/website.js";
import { selectPhone } from "../parsers/phone.js";
import { extractFirstName, extractCompanyName, isAmbiguousSellerName } from "../parsers/names.js";
import { phoneExistsInContacts } from "./firestore.js";
import { phoneExistsInNotion } from "./notion.js";
import { validateLead } from "./openai.js";
import { logger } from "../utils/logger.js";
import { env } from "../config/env.js";
import type { RawListing, QualifiedLead, PipelineResult } from "../types/lead.js";

// ─── Message template ────────────────────────────────────────────────────────

function buildOutreachMessage(firstName: string | null, companyName: string | null): string {
  const opening = firstName ? `Hey ${firstName},` : "Hey,";

  // Only substitute company name when it is 2 words or fewer (already guaranteed by parser,
  // but the AI path may return a longer name, so guard here too).
  const useCompany = companyName && companyName.trim().split(/\s+/).length <= 2;
  const businessPhrase = useCompany ? `for ${companyName}` : "for your business";

  return (
    `${opening} I just saw your ad on kijiji and noticed you don't have a website listed. ` +
    `My name is Anthony. I'm a web designer of over 10 years. ` +
    `I can build you a professional website ${businessPhrase} that showcases your past jobs ` +
    `and captures leads for $300. It would be 100% mobile responsive. ` +
    `Please let me know if you're interested and we can get started right away!`
  );
}

// ─── Pipeline ────────────────────────────────────────────────────────────────

export async function processListing(listing: RawListing): Promise<PipelineResult> {
  const { url } = listing;

  // Step 1: Website detection — skip immediately if any business website found
  const website = detectWebsite(listing.sidebarWebsite, listing.descriptionWebsites);
  if (website) {
    logger.info("Skipped: has website", { url, websiteUrl: website.url, foundIn: website.foundIn });
    return { url, status: "skipped", skipReason: "has_website" };
  }
  logger.debug("Step 1 passed: no website detected", { url });

  // Step 2: Phone selection
  const phoneResult = selectPhone(listing.descriptionPhones, listing.revealedPhone);
  logger.debug("Step 2 phone selection", {
    url,
    rawCount: listing.descriptionPhones.length,
    validCount: phoneResult.all.length,
    selectionReason: phoneResult.selectionReason,
  });

  if (!phoneResult.primary) {
    const skipReason = phoneResult.count === 0 ? "no_phone" : "invalid_phone";
    logger.info(`Skipped: ${skipReason}`, { url, rawPhoneCount: phoneResult.count });
    return { url, status: "skipped", skipReason };
  }

  const phone = phoneResult.primary;
  logger.debug("Step 2 passed: primary phone selected", {
    url,
    phone: phone.e164,
    source: phone.source,
    selectionReason: phoneResult.selectionReason,
    totalFound: phoneResult.count,
  });

  // Step 3: Firestore duplicate check (skipped in test mode — no credentials / no pollution)
  if (!env.TEST_MODE) {
    const firestoreDupe = await phoneExistsInContacts(phone.e164);
    if (firestoreDupe) {
      logger.info("Skipped: duplicate in Firestore contacts", { url, phone: phone.e164 });
      return { url, status: "skipped", skipReason: "duplicate_firestore", phone: phone.e164 };
    }
    logger.debug("Step 3 passed: no Firestore duplicate", { phone: phone.e164 });
  } else {
    logger.debug("Step 3 skipped: test mode, no Firestore dedup", { phone: phone.e164 });
  }

  // Step 4: Notion duplicate check (skipped in test mode or when Notion is disabled)
  if (!env.TEST_MODE && env.NOTION_ENABLED) {
    const notionDupe = await phoneExistsInNotion(phone.e164);
    if (notionDupe) {
      logger.info("Skipped: duplicate in Notion", { url, phone: phone.e164 });
      return { url, status: "skipped", skipReason: "duplicate_notion", phone: phone.e164 };
    }
    logger.debug("Step 4 passed: no Notion duplicate", { phone: phone.e164 });
  } else {
    const reason = env.TEST_MODE ? "test mode" : "Notion disabled";
    logger.debug(`Step 4 skipped: ${reason}`, { phone: phone.e164 });
  }

  // Step 5: Name extraction
  // High-confidence names already set during scraping; re-derive here as a fallback
  // in case the scraper path didn't run them (e.g. direct pipeline unit tests).
  let firstName: string | null = listing.firstName ?? null;
  let companyName: string | null = listing.companyName ?? null;

  if (!firstName && !companyName && listing.sellerName) {
    firstName = extractFirstName(listing.sellerName);
    companyName = extractCompanyName(listing.sellerName);
  }

  logger.debug("Step 5 name extraction", { url, firstName, companyName, sellerName: listing.sellerName });

  // Step 6: Optional AI validation — only for ambiguous seller names
  const sellerIsAmbiguous =
    !!listing.sellerName && isAmbiguousSellerName(listing.sellerName);

  if (sellerIsAmbiguous) {
    logger.debug("Step 6: seller name ambiguous, calling AI validation", {
      url,
      sellerName: listing.sellerName,
    });

    const validation = await validateLead({
      phone: phone.e164,
      sellerName: listing.sellerName!,
      title: listing.title,
      description: listing.description,
    });

    if (!validation.phoneValid || validation.skipReason) {
      logger.info("Skipped: AI rejected lead", {
        url,
        phone: phone.e164,
        aiReason: validation.skipReason,
      });
      return { url, status: "skipped", skipReason: "ai_rejected", phone: phone.e164 };
    }

    // Upgrade confidence if AI is sure
    if (validation.firstNameConfidence === "high" && listing.sellerName) {
      firstName = extractFirstName(listing.sellerName) ?? firstName;
    }
    if (validation.companyConfidence === "high" && listing.sellerName) {
      companyName = extractCompanyName(listing.sellerName) ?? companyName;
    }

    logger.debug("Step 6 AI validation passed", {
      url,
      firstNameConfidence: validation.firstNameConfidence,
      companyConfidence: validation.companyConfidence,
      resolvedFirstName: firstName,
      resolvedCompanyName: companyName,
    });
  } else {
    logger.debug("Step 6 skipped: name not ambiguous or no seller name", { url });
  }

  // Step 7: Build outreach message from exact template
  const outreachMessage = buildOutreachMessage(firstName, companyName);
  logger.debug("Step 7 message built", {
    url,
    firstName,
    companyName,
    messageLength: outreachMessage.length,
  });

  // Step 8: Assemble qualified lead
  const lead: QualifiedLead = {
    listingUrl: url,
    title: listing.title,
    location: listing.location ?? "",
    phone,
    allPhoneNumbers: phoneResult.all.map((p) => p.e164),
    phoneCount: phoneResult.count,
    phoneSelectionReason: phoneResult.selectionReason,
    outreachMessage,
    firstName,
    companyName,
    rawDescription: listing.description,
    scrapedAt: new Date(),
  };

  logger.info("Lead qualified", {
    url,
    phone: phone.e164,
    firstName,
    companyName,
    phoneCount: phoneResult.count,
  });

  return { url, status: "created", phone: phone.e164, lead };
}
