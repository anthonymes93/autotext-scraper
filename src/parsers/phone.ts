import type { NormalizedPhone } from "../types/lead.js";

export interface PhoneSelectionResult {
  primary: NormalizedPhone | null;
  all: NormalizedPhone[];
  count: number;
  selectionReason: string;
}

const PHONE_PATTERN =
  /\b(\+?1[-.\s]?)?\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}\b/g;

export function extractPhonesFromText(text: string): string[] {
  const found = new Set<string>();
  const matches = text.matchAll(new RegExp(PHONE_PATTERN.source, "g"));
  for (const match of matches) {
    found.add(match[0].trim());
  }
  return [...found];
}

export function toE164(raw: string): string | null {
  const digits = raw.replace(/\D/g, "");
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith("1")) return `+${digits}`;
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

export function selectPhone(
  rawPhones: string[],
  revealedPhone?: string
): PhoneSelectionResult {
  const all: NormalizedPhone[] = [];

  for (const raw of rawPhones) {
    const normalized = normalizePhone(raw, "description");
    if (normalized) all.push(normalized);
  }

  if (revealedPhone) {
    const normalized = normalizePhone(revealedPhone, "revealed");
    if (normalized) all.push(normalized);
  }

  const count = rawPhones.length + (revealedPhone ? 1 : 0);

  if (all.length === 0) {
    const selectionReason = count > 0 ? "found_but_invalid_format" : "none_found";
    return { primary: null, all: [], count, selectionReason };
  }

  if (all.length === 1) {
    return {
      primary: all[0],
      all,
      count,
      selectionReason: all[0].source === "revealed" ? "revealed_only" : "only_number",
    };
  }

  // Multiple phones — prefer description numbers, take first valid one
  const descriptionFirst = all.find((p) => p.source === "description") ?? all[0];
  return {
    primary: descriptionFirst,
    all,
    count,
    selectionReason: `first_of_${all.length}`,
  };
}
