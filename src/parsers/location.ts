export interface ParsedLocation {
  city: string | null;
  province: string | null; // ISO 3166-2 subdivision code, e.g. "ON", "BC"
  raw: string;
}

// Maps Canadian province/territory ISO codes to IANA timezone identifiers.
// Multi-zone provinces use the dominant / most-populated zone.
// Saskatchewan: America/Regina (Central Standard Time, no DST year-round).
const PROVINCE_TIMEZONE: Record<string, string> = {
  AB: "America/Edmonton",
  BC: "America/Vancouver",
  MB: "America/Winnipeg",
  NB: "America/Halifax",
  NL: "America/St_Johns",
  NS: "America/Halifax",
  NT: "America/Yellowknife",
  NU: "America/Rankin_Inlet",
  ON: "America/Toronto",
  PE: "America/Halifax",
  QC: "America/Toronto",
  SK: "America/Regina",
  YT: "America/Whitehorse",
};

// Full province/territory names → ISO code (lowercase for case-insensitive lookup).
const PROVINCE_NAME_TO_CODE: Record<string, string> = {
  "alberta": "AB",
  "british columbia": "BC",
  "manitoba": "MB",
  "new brunswick": "NB",
  "newfoundland and labrador": "NL",
  "newfoundland": "NL",
  "nova scotia": "NS",
  "northwest territories": "NT",
  "nunavut": "NU",
  "ontario": "ON",
  "prince edward island": "PE",
  "quebec": "QC",
  "québec": "QC",
  "saskatchewan": "SK",
  "yukon": "YT",
};

function resolveProvinceCode(text: string): string | null {
  const trimmed = text.trim();
  const upper = trimmed.toUpperCase();
  // Two-letter abbreviation exactly (e.g. "ON", "BC")
  if (/^[A-Z]{2}$/.test(upper) && Object.prototype.hasOwnProperty.call(PROVINCE_TIMEZONE, upper)) {
    return upper;
  }
  // Full name (e.g. "Ontario", "British Columbia")
  return PROVINCE_NAME_TO_CODE[trimmed.toLowerCase()] ?? null;
}

// Parses Kijiji raw location strings into structured city and province fields.
// Handles formats: "Oshawa, Ontario", "Toronto, ON", "Ontario", "Vancouver, BC".
export function parseLocation(raw: string): ParsedLocation {
  const trimmed = raw.trim();

  // Split on the last comma — city is everything before, province candidate after.
  const commaIdx = trimmed.lastIndexOf(",");
  if (commaIdx >= 0) {
    const cityCand = trimmed.slice(0, commaIdx).trim();
    const provinceCand = trimmed.slice(commaIdx + 1).trim();
    const province = resolveProvinceCode(provinceCand);
    if (province) {
      return { city: cityCand || null, province, raw };
    }
  }

  // No comma (or province unrecognized after comma) — try the full string as a province name.
  const province = resolveProvinceCode(trimmed);
  if (province) {
    return { city: null, province, raw };
  }

  return { city: trimmed || null, province: null, raw };
}

// Returns the IANA timezone for a raw location string, or null when province is unresolvable.
export function locationToTimezone(raw: string): string | null {
  const { province } = parseLocation(raw);
  return province ? (PROVINCE_TIMEZONE[province] ?? null) : null;
}
