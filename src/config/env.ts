import { z } from "zod";
import dotenv from "dotenv";

dotenv.config();

const EnvSchema = z.object({
  FIREBASE_PROJECT_ID: z.string().min(1),
  FIREBASE_CLIENT_EMAIL: z.string().email(),
  FIREBASE_PRIVATE_KEY: z.string().min(1),
  OPENAI_API_KEY: z.string().startsWith("sk-"),
  NOTION_API_KEY: z.string().startsWith("secret_"),
  NOTION_DATABASE_ID: z.string().min(1),
  MAX_PAGES_PER_RUN: z
    .string()
    .optional()
    .transform((v) => (v ? parseInt(v, 10) : 15))
    .pipe(z.number().int().min(1).max(100)),
  SCRAPE_WINDOW_MINUTES: z
    .string()
    .optional()
    .transform((v) => (v ? parseInt(v, 10) : 120))
    .pipe(z.number().int().min(10).max(1440)),
});

const parsed = EnvSchema.safeParse(process.env);

if (!parsed.success) {
  console.error("Invalid environment variables:");
  console.error(parsed.error.flatten().fieldErrors);
  process.exit(1);
}

export const env = parsed.data;
