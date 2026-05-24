import { Client } from "@notionhq/client";
import { env } from "../config/env.js";
import { logger } from "../utils/logger.js";
import type { QualifiedLead } from "../types/lead.js";

let _notion: Client | null = null;

function getClient(): Client {
  if (_notion) return _notion;
  _notion = new Client({ auth: env.NOTION_API_KEY });
  return _notion;
}

export async function phoneExistsInNotion(phone: string): Promise<boolean> {
  const notion = getClient();

  try {
    const response = await notion.databases.query({
      database_id: env.NOTION_DATABASE_ID,
      filter: {
        property: "Phone",
        phone_number: { equals: phone },
      },
      page_size: 1,
    });

    return response.results.length > 0;
  } catch (err) {
    logger.error("Notion phone lookup failed", { phone, err: String(err) });
    return false;
  }
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
        Phone: {
          phone_number: lead.phone.e164,
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
    logger.error("Failed to add lead to Notion", { phone: lead.phone.e164, err: String(err) });
  }
}
