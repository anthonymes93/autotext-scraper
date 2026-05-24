import "../config/env.js";
import { env } from "../config/env.js";
import { findNotionPhone, to10Digits } from "../services/notion.js";

async function main(): Promise<void> {
  const rawPhone = process.argv[2];

  if (!rawPhone) {
    console.error("Usage: npm run test:notion-phone -- <phone>");
    console.error("Example: npm run test:notion-phone -- 5063788184");
    process.exit(1);
  }

  if (!env.NOTION_ENABLED) {
    console.error("Error: NOTION_ENABLED must be true to run this test.");
    console.error("Set NOTION_ENABLED=true in your .env file.");
    process.exit(1);
  }

  const digits10 = to10Digits(rawPhone);

  console.log("─── Notion Phone Check ───────────────────────────────");
  console.log("Phone input   :", rawPhone);
  console.log("10-digit form :", digits10 ?? "(could not normalize — check format)");
  console.log("Property      :", env.NOTION_PHONE_PROPERTY);
  console.log("Database      :", env.NOTION_DATABASE_ID);
  console.log("──────────────────────────────────────────────────────");

  if (!digits10) {
    console.error("Error: phone number could not be normalized to 10 digits.");
    process.exit(1);
  }

  const result = await findNotionPhone(rawPhone);

  console.log("──────────────────────────────────────────────────────");
  console.log("Phone checked :", rawPhone);
  console.log("Normalized    :", result.digits10 ?? "(n/a)");
  console.log("Matched       :", result.found);
  if (result.found && result.pageId) {
    console.log("Page ID       :", result.pageId);
  }
  console.log("──────────────────────────────────────────────────────");

  process.exit(0);
}

main().catch((err) => {
  console.error("Fatal error:", String(err));
  process.exit(1);
});
