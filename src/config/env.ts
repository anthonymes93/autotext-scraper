import { z } from "zod";
import dotenv from "dotenv";

dotenv.config();

function intVar(defaultVal: number) {
  return z
    .string()
    .optional()
    .transform((v) => (v ? parseInt(v, 10) : defaultVal));
}

const EnvSchema = z.object({
  // Credentials — optional here so TEST_MODE works without a .env file.
  // Production requires all of them; enforced below.
  FIREBASE_PROJECT_ID: z.string().optional().default(""),
  FIREBASE_CLIENT_EMAIL: z.string().optional().default(""),
  FIREBASE_PRIVATE_KEY: z.string().optional().default(""),
  OPENAI_API_KEY: z.string().optional().default(""),
  NOTION_API_KEY: z.string().optional().default(""),
  NOTION_DATABASE_ID: z.string().optional().default(""),
  NOTION_ENABLED: z
    .string()
    .optional()
    .transform((v) => v === "true"),
  NOTION_WRITE_ENABLED: z
    .string()
    .optional()
    .transform((v) => v === "true"),
  NOTION_PHONE_PROPERTY: z.string().optional().default("Phone"),

  // Scrape timing
  MAX_PAGES_PER_RUN: intVar(15).pipe(z.number().int().min(1).max(100)),
  SCRAPE_WINDOW_MINUTES: intVar(120).pipe(z.number().int().min(10).max(1440)),
  DETAIL_DELAY_MIN_SECONDS: intVar(10).pipe(z.number().int().min(1).max(300)),
  DETAIL_DELAY_MAX_SECONDS: intVar(30).pipe(z.number().int().min(1).max(600)),
  // Optional cap on detail page visits per production run (unset = unlimited).
  LIVE_MAX_LISTINGS_PER_RUN: z
    .string()
    .optional()
    .transform((v) => (v ? parseInt(v, 10) : undefined)),

  // Test mode
  TEST_MODE: z
    .string()
    .optional()
    .transform((v) => v === "true"),
  TEST_MAX_PAGES: intVar(1).pipe(z.number().int().min(1).max(10)),
  TEST_MAX_LISTINGS: intVar(3).pipe(z.number().int().min(1).max(50)),
  TEST_WRITE_TO_FIRESTORE: z
    .string()
    .optional()
    .transform((v) => v === "true"),
  FAST_TEST_MODE: z
    .string()
    .optional()
    .transform((v) => v === "true"),

  // Run the pipeline once on startup, then keep the scheduler running.
  RUN_IMMEDIATELY: z
    .string()
    .optional()
    .transform((v) => v === "true"),
});

const parsed = EnvSchema.safeParse(process.env);

if (!parsed.success) {
  console.error("Invalid environment variables:");
  console.error(parsed.error.flatten().fieldErrors);
  process.exit(1);
}

const { data } = parsed;

// Production mode requires real credentials.
if (!data.TEST_MODE) {
  const errors: string[] = [];
  if (!data.FIREBASE_PROJECT_ID) errors.push("FIREBASE_PROJECT_ID is required");
  if (!data.FIREBASE_CLIENT_EMAIL) errors.push("FIREBASE_CLIENT_EMAIL is required");
  if (!data.FIREBASE_PRIVATE_KEY) errors.push("FIREBASE_PRIVATE_KEY is required");
  if (!data.OPENAI_API_KEY.startsWith("sk-")) errors.push("OPENAI_API_KEY must start with 'sk-'");
  if (data.NOTION_ENABLED) {
    if (!data.NOTION_API_KEY.startsWith("secret_") && !data.NOTION_API_KEY.startsWith("ntn_")) errors.push("NOTION_API_KEY must start with 'secret_' or 'ntn_'");
    if (!data.NOTION_DATABASE_ID) errors.push("NOTION_DATABASE_ID is required");
  }

  if (errors.length > 0) {
    console.error("Missing or invalid production environment variables:");
    errors.forEach((e) => console.error(`  - ${e}`));
    process.exit(1);
  }
}

export const env = data;
