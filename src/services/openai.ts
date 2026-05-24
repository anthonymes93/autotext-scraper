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
  sellerName: string | undefined;
  title: string;
  description: string;
}

const SYSTEM_PROMPT = `You are a lead qualification assistant for a Canadian home services outreach platform.
Given a Kijiji listing's details, determine:
1. Whether the phone number appears to be a real Canadian mobile number (not a Google Voice, VoIP, or clearly fake number)
2. Whether the seller name looks like a real first name (confidence: high/low/none)
3. Whether the seller name looks like a real company name (confidence: high/low/none)
4. If the lead should be skipped entirely and why

Respond in JSON only. No markdown. No explanation outside the JSON.`;

interface OpenAIValidationResponse {
  phoneValid: boolean;
  firstNameConfidence: "high" | "low" | "none";
  companyConfidence: "high" | "low" | "none";
  skipReason?: string;
}

export async function validateLead(input: ValidateLeadInput): Promise<ValidationResult> {
  const client = getClient();

  const userMessage = `
Phone: ${input.phone}
Seller Name: ${input.sellerName ?? "unknown"}
Title: ${input.title}
Description (first 500 chars): ${input.description.slice(0, 500)}
`.trim();

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

    const parsed = JSON.parse(content) as OpenAIValidationResponse;

    return {
      phoneValid: parsed.phoneValid ?? true,
      firstNameConfidence: parsed.firstNameConfidence ?? "none",
      companyConfidence: parsed.companyConfidence ?? "none",
      skipReason: parsed.skipReason,
    };
  } catch (err) {
    logger.error("OpenAI validation failed, defaulting to valid", { err: String(err) });
    return {
      phoneValid: true,
      firstNameConfidence: "low",
      companyConfidence: "low",
    };
  }
}

export async function generateOutreachMessage(params: {
  outreachName: string | null;
  title: string;
  location: string;
}): Promise<string> {
  const client = getClient();

  const greeting = params.outreachName ? `Hi ${params.outreachName}` : "Hi there";

  const prompt = `Generate a short, natural SMS outreach message (under 160 characters) for a Canadian home services lead.
Greeting: "${greeting}"
Service type: "${params.title}"
Location: "${params.location}"

The message should feel personal, not spammy, and end with a soft call to action.
Return just the message text. No quotes. No explanation.`;

  try {
    const response = await client.chat.completions.create({
      model: "gpt-4o-mini",
      temperature: 0.7,
      max_tokens: 80,
      messages: [{ role: "user", content: prompt }],
    });

    return response.choices[0]?.message?.content?.trim() ?? buildFallbackMessage(params);
  } catch (err) {
    logger.error("OpenAI outreach generation failed, using fallback", { err: String(err) });
    return buildFallbackMessage(params);
  }
}

function buildFallbackMessage(params: {
  outreachName: string | null;
  title: string;
  location: string;
}): string {
  const greeting = params.outreachName ? `Hi ${params.outreachName}` : "Hi there";
  return `${greeting}, I came across your listing on Kijiji and wanted to reach out. Would you be open to a quick chat?`;
}
