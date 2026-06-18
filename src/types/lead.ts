import { z } from "zod";

export const RawListingSchema = z.object({
  url: z.string().url(),
  listingId: z.string().optional(),
  title: z.string(),
  sellerName: z.string().optional(),
  location: z.string().optional(),
  description: z.string(),
  // Website fields
  sidebarWebsite: z.string().optional(),
  profileWebsite: z.string().optional(),
  descriptionWebsites: z.array(z.string()).default([]),
  // Phone fields (raw strings from page text)
  descriptionPhones: z.array(z.string()).default([]),
  revealedPhone: z.string().optional(),
  // Name fields — set only when confidence is HIGH during scraping
  firstName: z.string().optional(),
  companyName: z.string().optional(),
  sellerProfileUrl: z.string().optional(),
});

export type RawListing = z.infer<typeof RawListingSchema>;

export const NormalizedPhoneSchema = z.object({
  e164: z.string().regex(/^\+1\d{10}$/),
  raw: z.string(),
  source: z.enum(["description", "revealed"]),
});

export type NormalizedPhone = z.infer<typeof NormalizedPhoneSchema>;

export interface ValidationResult {
  phoneValid: boolean;
  firstNameConfidence: "high" | "low" | "none";
  companyConfidence: "high" | "low" | "none";
  skipReason?: string;
}

export interface QualifiedLead {
  listingUrl: string;
  title: string;
  location: string;
  // Primary phone chosen for outreach
  phone: NormalizedPhone;
  // All valid phones found in the listing
  allPhoneNumbers: string[];
  phoneCount: number;
  phoneSelectionReason: string;
  outreachMessage: string;
  // Name personalization — null when confidence was insufficient
  firstName: string | null;
  companyName: string | null;
  rawDescription: string;
  sellerProfileUrl: string | null;
  scrapedAt: Date;
}

export interface FirestoreOpportunity {
  listingUrl: string;
  listingId: string | null;
  title: string;
  location: string;
  phoneNumber: string;
  allPhoneNumbers: string[];
  phoneCount: number;
  phoneSelectionReason: string;
  textMessage: string;
  firstName: string | null;
  companyName: string | null;
  rawDescription: string;
  sellerProfileUrl: string | null;
  status: "ready";
  createdAt: FirebaseFirestore.Timestamp;
  scrapedAt: FirebaseFirestore.Timestamp;
  expiresAt: FirebaseFirestore.Timestamp;
  source: "kijiji";
}

// Preserved when a website is detected — not eligible for outreach queue.
// Query with where("status", "==", "website_detected") for relationship tracking.
export interface FirestoreWebsiteOpportunity {
  listingUrl: string;
  listingId: string | null;
  title: string;
  location: string | null;
  sellerName: string | null;
  firstName: string | null;
  companyName: string | null;
  rawDescription: string;
  sellerProfileUrl: string | null;
  websiteUrl: string;
  websiteFoundIn: "sidebar" | "profile" | "description";
  status: "website_detected";
  createdAt: FirebaseFirestore.Timestamp;
  scrapedAt: FirebaseFirestore.Timestamp;
  source: "kijiji";
}

export interface ScrapedListing {
  listingId: string;
  listingUrl: string;
  firstSeenAt: FirebaseFirestore.Timestamp;
  lastSeenAt: FirebaseFirestore.Timestamp;
  timesSeen: number;
  source: "kijiji";
  status: "seen" | "processed" | "skipped";
}

export interface FirestoreContact {
  phone: string;
  firstName: string | null;
  companyName: string | null;
  location: string | null;
  source: "kijiji";
  firstSeenAt: FirebaseFirestore.Timestamp;
  lastSeenAt: FirebaseFirestore.Timestamp;
  listingUrls: string[];
}

export type SkipReason =
  | "no_phone"
  | "invalid_phone"
  | "duplicate_firestore"
  | "duplicate_notion"
  | "ambiguous_needs_ai"
  | "ai_rejected"
  | "parse_error";

export type PipelineResult =
  | { url: string; status: "created"; phone: string; lead: QualifiedLead }
  | { url: string; status: "website_detected"; websiteUrl: string; websiteFoundIn: "sidebar" | "profile" | "description" }
  | { url: string; status: "skipped"; skipReason: SkipReason; phone?: string }
  | { url: string; status: "error"; error: string };
