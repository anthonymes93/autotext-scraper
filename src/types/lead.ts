import { z } from "zod";

export const RawListingSchema = z.object({
  url: z.string().url(),
  listingId: z.string().optional(),
  title: z.string(),
  sellerName: z.string().optional(),
  location: z.string().optional(),
  description: z.string(),
  sidebarWebsite: z.string().url().optional(),
  descriptionWebsites: z.array(z.string().url()).default([]),
  descriptionPhones: z.array(z.string()).default([]),
  revealedPhone: z.string().optional(),
});

export type RawListing = z.infer<typeof RawListingSchema>;

export const NormalizedPhoneSchema = z.object({
  e164: z.string().regex(/^\+1\d{10}$/),
  raw: z.string(),
  source: z.enum(["description", "revealed"]),
});

export type NormalizedPhone = z.infer<typeof NormalizedPhoneSchema>;

export interface ExtractedContact {
  phone: NormalizedPhone | null;
  website: string | null;
  firstName: string | null;
  companyName: string | null;
  outreachName: string | null;
}

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
  phone: NormalizedPhone;
  outreachMessage: string;
  outreachName: string | null;
  rawDescription: string;
  scrapedAt: Date;
}

export interface FirestoreOpportunity {
  listingUrl: string;
  title: string;
  location: string;
  phone: string;
  outreachMessage: string;
  outreachName: string | null;
  status: "ready";
  createdAt: FirebaseFirestore.Timestamp;
  expiresAt: FirebaseFirestore.Timestamp;
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
  | "has_website"
  | "no_phone"
  | "invalid_phone"
  | "duplicate_firestore"
  | "duplicate_notion"
  | "ai_rejected"
  | "parse_error";

export type PipelineResult =
  | { url: string; status: "created"; phone: string; lead: QualifiedLead }
  | { url: string; status: "skipped"; skipReason: SkipReason; phone?: string }
  | { url: string; status: "error"; error: string };
