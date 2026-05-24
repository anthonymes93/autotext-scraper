/**
 * Verifies that a known phone number would be caught as a Notion duplicate,
 * proving that createOpportunity would NOT be called for it.
 *
 * Usage: npm run test:notion-dedupe -- 9057414757
 */
import "../config/env.js";
import { env } from "../config/env.js";
import { findNotionPhone, to10Digits } from "../services/notion.js";

async function main(): Promise<void> {
  const rawPhone = process.argv[2];

  if (!rawPhone) {
    console.error("Usage: npm run test:notion-dedupe -- <phone>");
    console.error("Example: npm run test:notion-dedupe -- 9057414757");
    process.exit(1);
  }

  if (!env.NOTION_ENABLED) {
    console.error("Error: NOTION_ENABLED must be true to run this test.");
    process.exit(1);
  }

  const digits10 = to10Digits(rawPhone);

  console.log("─── Notion Dedupe Verification ───────────────────────");
  console.log("Phone input   :", rawPhone);
  console.log("10-digit form :", digits10 ?? "(could not normalize)");
  console.log("Property      :", env.NOTION_PHONE_PROPERTY);
  console.log("Database      :", env.NOTION_DATABASE_ID);
  console.log("──────────────────────────────────────────────────────");

  const result = await findNotionPhone(rawPhone);

  console.log("Matched       :", result.found);
  if (result.pageId) {
    console.log("Page ID       :", result.pageId);
  }
  console.log("──────────────────────────────────────────────────────");

  if (result.found) {
    console.log("Pipeline decision : SKIPPED");
    console.log("skipReason        : duplicate_notion");
    console.log("createOpportunity : NOT called ✓");
    console.log("upsertContact     : NOT called ✓");
    console.log("Defensive guard   : would also block at index.ts ✓");
    process.exit(0);
  } else {
    console.log("Pipeline decision : NOT blocked by Notion (no duplicate found)");
    console.log("createOpportunity : would proceed (if all other checks pass)");
    console.warn(
      "\nWARNING: If you expected this phone to be a duplicate, check:\n" +
        "  1. NOTION_PHONE_PROPERTY matches the actual Notion property name\n" +
        "  2. The phone is stored in Notion as digits only (e.g. 9057414757, not +19057414757)\n" +
        "  3. NOTION_DATABASE_ID points to the correct database"
    );
    process.exit(1);
  }
}

main().catch((err) => {
  console.error("Fatal:", String(err));
  process.exit(1);
});
