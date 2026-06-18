import { dedupeArray } from "../utils/normalize.js";

export interface WebsiteDetection {
  url: string;
  foundIn: "sidebar" | "profile" | "description";
}

// Matches full protocol URLs: https://... or http://...
const URL_PATTERN = /https?:\/\/[^\s<>"')\]]+/gi;

// Bare domain with www. prefix — any TLD, high confidence.
// \b after TLD prevents matching www.com out of www.company.ca when com is a substring of company.
const BARE_WWW_PATTERN = /\bwww\.[a-zA-Z0-9][a-zA-Z0-9-]{0,61}[a-zA-Z0-9]\.[a-zA-Z]{2,}\b(?:\/[^\s<>"')\]]*)?/gi;

// Bare domain without www. — restricted to common TLDs to avoid false positives (e.g. file.txt, v1.0).
// \b after TLD prevents matching .com out of .company when com is a TLD-prefix of company.
const BARE_DOMAIN_PATTERN = /\b[a-zA-Z0-9][a-zA-Z0-9-]{1,30}[a-zA-Z0-9]\.(?:com|ca|net|org|io|co|biz|info)\b(?:\/[^\s<>"')\]]*)?/gi;

// Used to strip email addresses before bare domain extraction so that
// "info@company.ca" does not produce a false-positive "company.ca" match.
const EMAIL_STRIP_PATTERN = /\S+@\S+/g;

const IGNORED_DOMAINS = [
  "kijiji.ca",
  "facebook.com",
  "instagram.com",
  "youtube.com",
  "twitter.com",
  "x.com",
  "linkedin.com",
  "google.com",
];

function isIgnoredDomain(url: string): boolean {
  try {
    const hostname = new URL(url).hostname.toLowerCase();
    return IGNORED_DOMAINS.some((d) => hostname === d || hostname.endsWith(`.${d}`));
  } catch {
    return false;
  }
}

// Unwraps Kijiji redirect URLs of the form https://www.kijiji.ca/r?url=<encoded-destination>.
// Relative redirect paths (/r?url=...) are resolved against the kijiji.ca base.
// Returns the original URL unchanged if it is not a Kijiji redirect or the destination is invalid.
export function unwrapKijijiRedirect(url: string): string {
  try {
    const parsed = new URL(url, "https://www.kijiji.ca");
    if (
      (parsed.hostname === "kijiji.ca" || parsed.hostname === "www.kijiji.ca") &&
      (parsed.pathname === "/r" || parsed.pathname.startsWith("/r/")) &&
      parsed.searchParams.has("url")
    ) {
      const destination = decodeURIComponent(parsed.searchParams.get("url")!);
      new URL(destination); // throws if destination is not a valid absolute URL
      return destination;
    }
  } catch {
    // not a redirect, or destination is invalid — fall through
  }
  return url;
}

export function extractWebsitesFromText(text: string): string[] {
  const raw: string[] = [];

  // Pass 1: full protocol URLs — unwrap Kijiji redirects before the ignored-domain check
  for (const match of text.matchAll(URL_PATTERN)) {
    const url = unwrapKijijiRedirect(match[0].replace(/[.,;!?]+$/, ""));
    if (!isIgnoredDomain(url)) raw.push(url);
  }

  // Strip emails before bare domain passes to prevent extracting company.ca from info@company.ca
  const textWithoutEmails = text.replace(EMAIL_STRIP_PATTERN, "");

  // Pass 2: bare domains with www. prefix — any TLD, high confidence
  for (const match of textWithoutEmails.matchAll(BARE_WWW_PATTERN)) {
    const url = "https://" + match[0].replace(/[.,;!?]+$/, "");
    if (!isIgnoredDomain(url)) raw.push(url);
  }

  // Pass 3: bare domains without www., common TLDs only
  for (const match of textWithoutEmails.matchAll(BARE_DOMAIN_PATTERN)) {
    const url = "https://" + match[0].replace(/[.,;!?]+$/, "");
    if (!isIgnoredDomain(url)) raw.push(url);
  }

  // Deduplicate by canonical hostname (www-agnostic) so that www.company.ca and company.ca
  // are treated as the same host. First-seen form wins (Pass 1 > Pass 2 > Pass 3).
  const seenHosts = new Set<string>();
  const result: string[] = [];
  for (const url of dedupeArray(raw)) {
    try {
      const hostname = new URL(url).hostname.toLowerCase();
      const canonical = hostname.startsWith("www.") ? hostname.slice(4) : hostname;
      if (!seenHosts.has(canonical)) {
        seenHosts.add(canonical);
        result.push(url);
      }
    } catch {
      // invalid URL — skip
    }
  }
  return result;
}

export function detectWebsite(
  sidebarWebsite: string | undefined,
  descriptionWebsites: string[],
  profileWebsite?: string
): WebsiteDetection | null {
  if (sidebarWebsite && !isIgnoredDomain(sidebarWebsite)) {
    return { url: sidebarWebsite, foundIn: "sidebar" };
  }
  if (profileWebsite && !isIgnoredDomain(profileWebsite)) {
    return { url: profileWebsite, foundIn: "profile" };
  }
  const first = descriptionWebsites.find((u) => !isIgnoredDomain(u));
  if (first) {
    return { url: first, foundIn: "description" };
  }
  return null;
}
