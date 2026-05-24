import { Client, APIResponseError } from "@notionhq/client";
import { env } from "../config/env.js";
import { logger } from "../utils/logger.js";
import { sleep } from "../utils/delay.js";
import type { QualifiedLead } from "../types/lead.js";

let _notion: Client | null = null;

function getClient(): Client {
  if (_notion) return _notion;
  _notion = new Client({ auth: env.NOTION_API_KEY });
  return _notion;
}

// Strips formatting and leading country code, returning a bare 10-digit string.
// "+15063788184" → "5063788184", "5063788184" → "5063788184"
export function to10Digits(phone: string): string | null {
  const digits = phone.replace(/\D/g, "");
  if (digits.length === 10) return digits;
  if (digits.length === 11 && digits.startsWith("1")) return digits.slice(1);
  return null;
}

export interface NotionPhoneCheckResult {
  found: boolean;
  pageId: string | null;
  digits10: string | null;
}

const MAX_RETRIES = 3;

async function checkNotionPhone(phone: string): Promise<NotionPhoneCheckResult> {
  const notion = getClient();
  const property = env.NOTION_PHONE_PROPERTY;
  const digits10 = to10Digits(phone);

  if (!digits10) {
    logger.warn("Could not normalize phone to 10 digits for Notion lookup, skipping", { phone });
    return { found: false, pageId: null, digits10: null };
  }

  logger.debug("Notion duplicate check started", {
    phone,
    digits10,
    property,
    database: env.NOTION_DATABASE_ID,
  });

  let lastErr: unknown = new Error("Notion query did not execute");

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      const response = await notion.databases.query({
        database_id: env.NOTION_DATABASE_ID,
        filter: {
          property,
          phone_number: { equals: digits10 },
        },
        page_size: 5,
      });

      if (response.results.length === 0) {
        logger.debug("Notion duplicate check: no match found", { phone, digits10, property });
        return { found: false, pageId: null, digits10 };
      }

      const page = response.results[0];
      const pageId = page.id;

      let notionPhoneRaw: string | undefined;
      if ("properties" in page) {
        const prop = page.properties[property];
        if (prop?.type === "phone_number" && typeof prop.phone_number === "string") {
          notionPhoneRaw = prop.phone_number || undefined;
        }
      }

      logger.info("Notion duplicate found", {
        searchPhone: phone,
        digits10,
        property,
        pageId,
        notionPhone: notionPhoneRaw,
        notionDigits10: notionPhoneRaw ? to10Digits(notionPhoneRaw) : undefined,
      });

      return { found: true, pageId, digits10 };
    } catch (err) {
      if (
        err instanceof APIResponseError &&
        err.status === 429 &&
        attempt < MAX_RETRIES
      ) {
        const waitMs = 2_000 * attempt;
        logger.warn("Notion rate limited, retrying", { phone, attempt, waitMs });
        await sleep(waitMs);
        continue;
      }
      lastErr = err;
      break;
    }
  }

  logger.error("Notion duplicate check failed, treating as no duplicate", {
    phone,
    err: String(lastErr),
  });
  return { found: false, pageId: null, digits10 };
}

// Pipeline API — returns boolean so callers need no type changes.
export async function phoneExistsInNotion(phone: string): Promise<boolean> {
  const { found } = await checkNotionPhone(phone);
  return found;
}

// Test-script API — returns full match details without affecting pipeline behavior.
export async function findNotionPhone(phone: string): Promise<NotionPhoneCheckResult> {
  return checkNotionPhone(phone);
}

export async function addLeadToNotion(lead: QualifiedLead): Promise<void> {
  const notion = getClient();

  try {
    await notion.pages.create({
      parent: { database_id: env.NOTION_DATABASE_ID },
      properties: {
        Name: {
          title: [{ text: { content: lead.title } }],
        },
        [env.NOTION_PHONE_PROPERTY]: {
          // Store as 10-digit to match existing CRM data and ensure future dedup queries hit.
          phone_number: to10Digits(lead.phone.e164) ?? lead.phone.e164,
        },
        Location: {
          rich_text: [{ text: { content: lead.location } }],
        },
        Source: {
          select: { name: "Kijiji" },
        },
        Status: {
          select: { name: "New" },
        },
        "Listing URL": {
          url: lead.listingUrl,
        },
        "Outreach Message": {
          rich_text: [{ text: { content: lead.outreachMessage } }],
        },
      },
    });

    logger.debug("Added lead to Notion", { phone: lead.phone.e164 });
  } catch (err) {
    logger.error("Failed to add lead to Notion", {
      phone: lead.phone.e164,
      err: String(err),
    });
  }
}
