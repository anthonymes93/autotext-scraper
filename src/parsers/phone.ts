import type { NormalizedPhone } from "../types/lead.js";

// Maps Canadian NPA (area code) to IANA timezone.
// Covers all active Canadian area codes as of 2025.
// Saskatchewan uses America/Regina (Central, no DST).
// Multi-province area codes (867 covers YT/NT/NU) use the dominant zone.
const AREA_CODE_TIMEZONE: Record<string, string> = {
  // British Columbia — America/Vancouver
  "257": "America/Vancouver",
  "236": "America/Vancouver",
  "250": "America/Vancouver",
  "604": "America/Vancouver",
  "672": "America/Vancouver",
  "778": "America/Vancouver",
  // Alberta — America/Edmonton
  "368": "America/Edmonton",
  "403": "America/Edmonton",
  "587": "America/Edmonton",
  "780": "America/Edmonton",
  "825": "America/Edmonton",
  // Saskatchewan — America/Regina (Central, no DST)
  "306": "America/Regina",
  "474": "America/Regina",
  "639": "America/Regina",
  // Manitoba — America/Winnipeg
  "584": "America/Winnipeg",
  "204": "America/Winnipeg",
  "431": "America/Winnipeg",
  // Ontario — America/Toronto
  "226": "America/Toronto",
  "249": "America/Toronto",
  "289": "America/Toronto",
  "343": "America/Toronto",
  "365": "America/Toronto",
  "382": "America/Toronto",
  "416": "America/Toronto",
  "437": "America/Toronto",
  "519": "America/Toronto",
  "548": "America/Toronto",
  "613": "America/Toronto",
  "647": "America/Toronto",
  "683": "America/Toronto",
  "705": "America/Toronto",
  "753": "America/Toronto",
  "807": "America/Toronto",
  "742": "America/Toronto",
  "905": "America/Toronto",
  // Quebec — America/Toronto (Eastern, same rules as Ontario)
  "263": "America/Toronto",
  "354": "America/Toronto",
  "468": "America/Toronto",
  "367": "America/Toronto",
  "418": "America/Toronto",

  "438": "America/Toronto",
  "450": "America/Toronto",
  "514": "America/Toronto",
  "579": "America/Toronto",
  "581": "America/Toronto",
  "819": "America/Toronto",
  "873": "America/Toronto",
  // Atlantic provinces (NB, NS, PEI) — America/Halifax
  "428": "America/Moncton",
  "506": "America/Halifax",
  "782": "America/Halifax",
  "902": "America/Halifax",
  // Newfoundland and Labrador — America/St_Johns (UTC-3:30)
  "879": "America/St_Johns",
  "709": "America/St_Johns",
  // Northern territories (YT/NT/NU shared 867) — America/Yellowknife as default
  "867": "America/Yellowknife",
};

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

// Returns the IANA timezone for the area code embedded in a Canadian E.164 number (+1NPA…).
// Returns null for unrecognized or non-Canadian numbers.
export function areaCodeToTimezone(e164: string): string | null {
  if (!e164.startsWith("+1") || e164.length < 5) return null;
  const npa = e164.slice(2, 5);
  return AREA_CODE_TIMEZONE[npa] ?? null;
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
