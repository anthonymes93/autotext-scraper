import { hasWebsite } from "../parsers/website.js";
import { pickBestPhone } from "../parsers/phone.js";
import { extractFirstName, extractCompanyName, buildOutreachName } from "../parsers/names.js";
import { phoneExistsInContacts } from "./firestore.js";
import { phoneExistsInNotion } from "./notion.js";
import { validateLead, generateOutreachMessage } from "./openai.js";
import { logger } from "../utils/logger.js";
import type { RawListing, QualifiedLead, PipelineResult } from "../types/lead.js";

export async function processListing(listing: RawListing): Promise<PipelineResult> {
  const { url } = listing;

  if (hasWebsite(listing.sidebarWebsite, listing.descriptionWebsites)) {
    logger.info("Skipped: has website", { url });
    return { url, status: "skipped", skipReason: "has_website" };
  }

  const phone = pickBestPhone(listing.descriptionPhones, listing.revealedPhone);

  if (!phone) {
    logger.info("Skipped: no phone found", { url });
    return { url, status: "skipped", skipReason: "no_phone" };
  }

  const firestoreDupe = await phoneExistsInContacts(phone.e164);
  if (firestoreDupe) {
    logger.info("Skipped: duplicate in Firestore", { phone: phone.e164 });
    return { url, status: "skipped", skipReason: "duplicate_firestore", phone: phone.e164 };
  }

  const notionDupe = await phoneExistsInNotion(phone.e164);
  if (notionDupe) {
    logger.info("Skipped: duplicate in Notion", { phone: phone.e164 });
    return { url, status: "skipped", skipReason: "duplicate_notion", phone: phone.e164 };
  }

  const validation = await validateLead({
    phone: phone.e164,
    sellerName: listing.sellerName,
    title: listing.title,
    description: listing.description,
  });

  if (!validation.phoneValid || validation.skipReason) {
    logger.info("Skipped: AI rejected", { url, reason: validation.skipReason });
    return { url, status: "skipped", skipReason: "ai_rejected", phone: phone.e164 };
  }

  const firstName = listing.sellerName ? extractFirstName(listing.sellerName) : null;
  const companyName = listing.sellerName ? extractCompanyName(listing.sellerName) : null;

  const outreachName = buildOutreachName(
    firstName,
    validation.firstNameConfidence,
    companyName,
    validation.companyConfidence
  );

  const outreachMessage = await generateOutreachMessage({
    outreachName,
    title: listing.title,
    location: listing.location ?? "",
  });

  const lead: QualifiedLead = {
    listingUrl: url,
    title: listing.title,
    location: listing.location ?? "",
    phone,
    outreachMessage,
    outreachName,
    rawDescription: listing.description,
    scrapedAt: new Date(),
  };

  return { url, status: "created", phone: phone.e164, lead };
}
