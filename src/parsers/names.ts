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
];

export function looksLikeCompany(name: string): boolean {
  const lower = name.toLowerCase();
  return COMPANY_SUFFIXES.some((suffix) => lower.includes(suffix));
}

export function extractFirstName(sellerName: string): string | null {
  const cleaned = normalizeWhitespace(sellerName);
  if (!cleaned) return null;

  if (looksLikeCompany(cleaned)) return null;

  const parts = cleaned.split(/\s+/);
  const first = parts[0];

  if (first.length < 2 || first.length > 30) return null;
  if (!/^[A-Za-zÀ-ÿ'-]+$/.test(first)) return null;

  return first.charAt(0).toUpperCase() + first.slice(1).toLowerCase();
}

export function extractCompanyName(sellerName: string): string | null {
  const cleaned = normalizeWhitespace(sellerName);
  if (!cleaned) return null;

  const wordCount = cleaned.split(/\s+/).length;
  if (wordCount > 2) return null;

  if (looksLikeCompany(cleaned)) return cleaned;

  return null;
}

export function buildOutreachName(
  firstName: string | null,
  firstNameConfidence: "high" | "low" | "none",
  companyName: string | null,
  companyConfidence: "high" | "low" | "none"
): string | null {
  if (firstName && firstNameConfidence === "high") return firstName;
  if (companyName && companyConfidence === "high") return companyName;
  return null;
}
