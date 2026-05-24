import OpenAI from "openai";
import { env } from "../config/env.js";
import { logger } from "../utils/logger.js";
import type { ValidationResult } from "../types/lead.js";

let _client: OpenAI | null = null;

function getClient(): OpenAI {
  if (_client) return _client;
  _client = new OpenAI({ apiKey: env.OPENAI_API_KEY });
  return _client;
}

interface ValidateLeadInput {
  phone: string;
  sellerName: string;
  title: string;
  description: string;
}

const SYSTEM_PROMPT = `You are a lead qualification assistant for a Canadian home services outreach platform.
You are called ONLY for listings where the seller name is ambiguous — it could not be classified as a person's first name or a company name by heuristics alone.

Given the listing details, determine:
1. Whether the phone number appears to be a real Canadian mobile or landline (not VoIP / clearly fake)
2. Whether the seller name most likely represents a real first name (confidence: high/low/none)
3. Whether the seller name most likely represents a company name (confidence: high/low/none)
4. Whether the lead should be skipped entirely, and why (omit if no skip reason)

Rules:
- If the name looks like a full name (e.g. "Joe Smith"), firstNameConfidence should be "high"
- If it looks like a business but is 3+ words, companyConfidence should be "low"
- Only set skipReason if the lead is clearly spam, fake, or unrelated to home services

Respond in valid JSON only. No markdown. No explanation outside the JSON.
Schema: { "phoneValid": boolean, "firstNameConfidence": "high"|"low"|"none", "companyConfidence": "high"|"low"|"none", "skipReason": string | undefined }`;

export async function validateLead(input: ValidateLeadInput): Promise<ValidationResult> {
  const client = getClient();

  const userMessage = [
    `Phone: ${input.phone}`,
    `Seller Name: ${input.sellerName}`,
    `Title: ${input.title}`,
    `Description (first 400 chars): ${input.description.slice(0, 400)}`,
  ].join("\n");

  try {
    const response = await client.chat.completions.create({
      model: "gpt-4o-mini",
      temperature: 0,
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: userMessage },
      ],
      response_format: { type: "json_object" },
    });

    const content = response.choices[0]?.message?.content;
    if (!content) throw new Error("Empty OpenAI response");

    const parsed = JSON.parse(content) as Partial<ValidationResult>;

    return {
      phoneValid: parsed.phoneValid ?? true,
      firstNameConfidence: parsed.firstNameConfidence ?? "none",
      companyConfidence: parsed.companyConfidence ?? "none",
      skipReason: parsed.skipReason,
    };
  } catch (err) {
    logger.error("OpenAI validation failed, proceeding without AI result", { err: String(err) });
    // Fail open — don't skip a lead just because AI was unavailable
    return { phoneValid: true, firstNameConfidence: "none", companyConfidence: "none" };
  }
}
