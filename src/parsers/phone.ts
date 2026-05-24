import type { NormalizedPhone } from "../types/lead.js";

const PHONE_PATTERNS = [
  /\b(\+?1[-.\s]?)?\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}\b/g,
  /\b(\+?1[-.\s]?)?\d{3}[-.\s]\d{3}[-.\s]\d{4}\b/g,
];

export function extractPhonesFromText(text: string): string[] {
  const found = new Set<string>();

  for (const pattern of PHONE_PATTERNS) {
    const matches = text.matchAll(new RegExp(pattern.source, "g"));
    for (const match of matches) {
      found.add(match[0].trim());
    }
  }

  return [...found];
}

export function toE164(raw: string): string | null {
  const digits = raw.replace(/\D/g, "");

  if (digits.length === 10) {
    return `+1${digits}`;
  }

  if (digits.length === 11 && digits.startsWith("1")) {
    return `+${digits}`;
  }

  return null;
}

export function normalizePhone(
  raw: string,
  source: NormalizedPhone["source"]
): NormalizedPhone | null {
  const e164 = toE164(raw);
  if (!e164) return null;

  return { e164, raw, source };
}

export function pickBestPhone(
  descriptionPhones: string[],
  revealedPhone?: string
): NormalizedPhone | null {
  for (const raw of descriptionPhones) {
    const normalized = normalizePhone(raw, "description");
    if (normalized) return normalized;
  }

  if (revealedPhone) {
    return normalizePhone(revealedPhone, "revealed");
  }

  return null;
}
