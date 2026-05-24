import { normalizeWhitespace } from "../utils/normalize.js";

const COMPANY_SUFFIXES = [
  "inc",
  "llc",
  "ltd",
  "corp",
  "co",
  "services",
  "solutions",
  "group",
  "pro",
  "pros",
  "contractors",
  "renovations",
  "construction",
  "plumbing",
  "electric",
  "electrical",
  "hvac",
  "roofing",
  "landscaping",
  "painting",
  "flooring",
  "carpentry",
  "welding",
  "heating",
  "cooling",
  "masonry",
  "drywall",
  "fencing",
];

export function looksLikeCompany(name: string): boolean {
  const lower = name.toLowerCase();
  return COMPANY_SUFFIXES.some((suffix) => lower.includes(suffix));
}

// Returns the first name only when confidence is HIGH:
// - Not a company name
// - Single word that looks like a real first name
export function extractFirstName(sellerName: string): string | null {
  const cleaned = normalizeWhitespace(sellerName);
  if (!cleaned) return null;
  if (looksLikeCompany(cleaned)) return null;

  const parts = cleaned.split(/\s+/);
  const first = parts[0];

  if (first.length < 2 || first.length > 25) return null;
  if (!/^[A-Za-zÀ-ÿ'-]+$/.test(first)) return null;

  return first.charAt(0).toUpperCase() + first.slice(1).toLowerCase();
}

// Returns the company name only when confidence is HIGH:
// - 2 words or fewer
// - Contains a recognized company/trade suffix
export function extractCompanyName(sellerName: string): string | null {
  const cleaned = normalizeWhitespace(sellerName);
  if (!cleaned) return null;

  const wordCount = cleaned.split(/\s+/).length;
  if (wordCount > 2) return null;

  if (looksLikeCompany(cleaned)) return cleaned;

  return null;
}

// Returns true when a seller name exists but can't be classified confidently
// as either a person's first name or a company name — the case where AI adds value.
export function isAmbiguousSellerName(sellerName: string): boolean {
  const cleaned = normalizeWhitespace(sellerName);
  if (!cleaned) return false;
  if (extractFirstName(cleaned)) return false;
  if (extractCompanyName(cleaned)) return false;
  return true;
}
