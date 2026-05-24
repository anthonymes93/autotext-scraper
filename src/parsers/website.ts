import { dedupeArray } from "../utils/normalize.js";

export interface WebsiteDetection {
  url: string;
  foundIn: "sidebar" | "description";
}

const URL_PATTERN = /https?:\/\/[^\s<>"')\]]+/gi;

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

export function extractWebsitesFromText(text: string): string[] {
  const matches = text.matchAll(URL_PATTERN);
  const urls: string[] = [];
  for (const match of matches) {
    const url = match[0].replace(/[.,;!?]+$/, "");
    if (!isIgnoredDomain(url)) urls.push(url);
  }
  return dedupeArray(urls);
}

export function detectWebsite(
  sidebarWebsite: string | undefined,
  descriptionWebsites: string[]
): WebsiteDetection | null {
  if (sidebarWebsite && !isIgnoredDomain(sidebarWebsite)) {
    return { url: sidebarWebsite, foundIn: "sidebar" };
  }
  const first = descriptionWebsites.find((u) => !isIgnoredDomain(u));
  if (first) {
    return { url: first, foundIn: "description" };
  }
  return null;
}
