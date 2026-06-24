import admin from "firebase-admin";
import { env } from "../config/env.js";
import { logger } from "../utils/logger.js";
import type { FirestoreContact, FirestoreOpportunity, FirestoreWebsiteOpportunity, QualifiedLead, RawListing, ScrapedListing } from "../types/lead.js";

let _db: FirebaseFirestore.Firestore | null = null;

// Dotenv may or may not expand \n in quoted values depending on version and quoting style.
// If the key already contains real newlines, use it as-is; otherwise convert literal \n sequences.
function parsePrivateKey(raw: string): string {
  if (raw.includes("\n")) return raw;
  return raw.replace(/\\n/g, "\n");
}

function getDb(): FirebaseFirestore.Firestore {
  if (_db) return _db;

  if (!admin.apps.length) {
    const rawKey = env.FIREBASE_PRIVATE_KEY;

    if (env.TEST_MODE) {
      logger.info("[TEST] Firebase private key diagnostic", {
        keyLength: rawKey.length,
        hasLiteralEscapedNewlines: rawKey.includes("\\n"),
        hasRealNewlines: rawKey.includes("\n"),
      });
    }

    admin.initializeApp({
      credential: admin.credential.cert({
        projectId: env.FIREBASE_PROJECT_ID,
        clientEmail: env.FIREBASE_CLIENT_EMAIL,
        privateKey: parsePrivateKey(rawKey),
      }),
    });
  }

  _db = admin.firestore();
  return _db;
}

// Extracts the stable numeric listing ID from a Kijiji URL (last path segment).
export function extractListingId(url: string): string | null {
  const match = url.match(/\/(\d+)(?:[/?#].*)?$/);
  return match ? match[1] : null;
}

export async function listingAlreadySeen(listingId: string): Promise<boolean> {
  const db = getDb();
  const snap = await db.collection("scrapedListings").doc(listingId).get();
  return snap.exists;
}

export async function markListingSeen(listingId: string, listingUrl: string): Promise<void> {
  const db = getDb();
  const ref = db.collection("scrapedListings").doc(listingId);
  const now = admin.firestore.Timestamp.now();

  await db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) {
      const doc: ScrapedListing = {
        listingId,
        listingUrl,
        firstSeenAt: now,
        lastSeenAt: now,
        timesSeen: 1,
        source: "kijiji",
        status: "seen",
      };
      tx.set(ref, doc);
    } else {
      tx.update(ref, {
        lastSeenAt: now,
        timesSeen: admin.firestore.FieldValue.increment(1),
      });
    }
  });
}

export async function updateListingStatus(
  listingId: string,
  status: ScrapedListing["status"]
): Promise<void> {
  const db = getDb();
  await db.collection("scrapedListings").doc(listingId).update({ status });
  logger.debug("Updated listing status", { listingId, status });
}

export async function phoneExistsInContacts(phone: string): Promise<boolean> {
  const db = getDb();
  const snap = await db
    .collection("contacts")
    .where("phone", "==", phone)
    .limit(1)
    .get();

  return !snap.empty;
}

// Skip reasons written by the mobile app that signal a timing problem, not a
// quality rejection. A contractor whose ad expired or was manually removed is
// still a valid prospect — allow a new listing from the same phone to resurface.
const REENTRY_SAFE_SKIP_REASONS = new Set([
  "ad_no_longer_available",
]);

export interface PhoneBlockDecision {
  block: boolean;
  // new_phone          — phone has never been seen; pass through
  // resurfaced_allowed — phone was seen but skip reason permits re-entry
  // same_listing       — exact same listingId was already processed
  // duplicate_firestore — conservative block (contacted, bad number, etc.)
  reason: "new_phone" | "same_listing" | "resurfaced_allowed" | "duplicate_firestore";
  previousSkipReason?: string;
  previousListingId?: string | null;
  previousStatus?: string;
}

// Replaces the unconditional phoneExistsInContacts block with reason-aware logic.
// Allows a new listing from the same phone to enter the queue when the prior skip
// was a timing issue (ad gone, future opportunity) rather than a quality rejection.
export async function shouldBlockPhoneForNewListing(
  phone: string,
  incomingListingId: string,
): Promise<PhoneBlockDecision> {
  const db = getDb();

  // 1. Phone never seen — pass through immediately.
  const contactSnap = await db
    .collection("contacts")
    .where("phone", "==", phone)
    .limit(1)
    .get();
  if (contactSnap.empty) {
    return { block: false, reason: "new_phone" };
  }

  // 2. Find the most recent opportunity for this phone to read its skip reason.
  //    Fetching all and sorting client-side avoids a composite Firestore index.
  const oppSnap = await db
    .collection("opportunities")
    .where("phoneNumber", "==", phone)
    .get();

  if (oppSnap.empty) {
    // Contact exists but no matching opportunity — block conservatively.
    logger.debug("Phone in contacts but no opportunity found; blocking conservatively", { phone });
    return { block: true, reason: "duplicate_firestore" };
  }

  const mostRecent = oppSnap.docs
    .map((d) => d.data())
    .sort((a, b) => {
      const aMs = (a.createdAt as FirebaseFirestore.Timestamp)?.toMillis?.() ?? 0;
      const bMs = (b.createdAt as FirebaseFirestore.Timestamp)?.toMillis?.() ?? 0;
      return bMs - aMs;
    })[0];

  const previousListingId = (mostRecent.listingId as string | null | undefined) ?? null;
  const previousSkipReason = (mostRecent.skipReason as string | undefined) ?? undefined;
  const previousStatus = (mostRecent.status as string | undefined) ?? undefined;

  // 3. Same listing — block regardless of skip reason.
  if (incomingListingId && previousListingId && incomingListingId === previousListingId) {
    return { block: true, reason: "same_listing", previousSkipReason, previousListingId, previousStatus };
  }

  // 4. Re-entry-safe skip reason on a different listing — allow resurfacing.
  if (previousSkipReason && REENTRY_SAFE_SKIP_REASONS.has(previousSkipReason)) {
    return { block: false, reason: "resurfaced_allowed", previousSkipReason, previousListingId, previousStatus };
  }

  // 5. Conservative default — block.
  return { block: true, reason: "duplicate_firestore", previousSkipReason, previousListingId, previousStatus };
}

export async function upsertContact(lead: QualifiedLead): Promise<void> {
  const db = getDb();
  const now = admin.firestore.Timestamp.now();
  const phone = lead.phone.e164;

  const query = await db
    .collection("contacts")
    .where("phone", "==", phone)
    .limit(1)
    .get();

  if (!query.empty) {
    const docRef = query.docs[0].ref;
    await docRef.update({
      lastSeenAt: now,
      listingUrls: admin.firestore.FieldValue.arrayUnion(lead.listingUrl),
    });
    logger.debug("Updated existing contact", { phone });
    return;
  }

  const contact: FirestoreContact = {
    phone,
    firstName: lead.firstName,
    companyName: lead.companyName,
    location: lead.location,
    source: "kijiji",
    firstSeenAt: now,
    lastSeenAt: now,
    listingUrls: [lead.listingUrl],
  };

  await db.collection("contacts").add(contact);
  logger.debug("Created new contact", { phone });
}

export async function createOpportunity(lead: QualifiedLead): Promise<string> {
  const db = getDb();
  const now = admin.firestore.Timestamp.now();

  const expiresAt = admin.firestore.Timestamp.fromDate(
    new Date(Date.now() + 10 * 24 * 60 * 60 * 1000)
  );

  const opportunity: FirestoreOpportunity = {
    listingUrl: lead.listingUrl,
    listingId: extractListingId(lead.listingUrl),
    title: lead.title,
    location: lead.location,
    phoneNumber: lead.phone.e164,
    allPhoneNumbers: lead.allPhoneNumbers,
    phoneCount: lead.phoneCount,
    phoneSelectionReason: lead.phoneSelectionReason,
    textMessage: lead.outreachMessage,
    firstName: lead.firstName,
    companyName: lead.companyName,
    rawDescription: lead.rawDescription,
    sellerProfileUrl: lead.sellerProfileUrl,
    status: "ready",
    createdAt: now,
    scrapedAt: admin.firestore.Timestamp.fromDate(lead.scrapedAt),
    expiresAt,
    source: "kijiji",
    listingCity: lead.listingCity,
    listingProvince: lead.listingProvince,
    listingTimezone: lead.listingTimezone,
    phoneAreaCodeTimezone: lead.phoneAreaCodeTimezone,
    resolvedTimezone: lead.resolvedTimezone,
    timezoneSource: lead.timezoneSource,
    timezoneMismatch: lead.timezoneMismatch,
  };

  if (env.TEST_MODE) {
    logger.info("[TEST] Opportunity payload", {
      ...opportunity,
      createdAt: opportunity.createdAt.toDate().toISOString(),
      expiresAt: opportunity.expiresAt.toDate().toISOString(),
    });
  }

  const docRef = await db.collection("opportunities").add(opportunity);
  logger.info("Created opportunity", { id: docRef.id, phoneNumber: lead.phone.e164 });
  return docRef.id;
}

// Returns the deterministic Firestore doc ID for a website_detected opportunity.
// The canonical hostname (www.-stripped, lower-cased) is stable across all listings
// from the same business, making the document idempotent by website domain.
export function websiteOpportunityDocId(websiteUrl: string): string {
  try {
    const hostname = new URL(websiteUrl).hostname.toLowerCase();
    const canonical = hostname.startsWith("www.") ? hostname.slice(4) : hostname;
    return `website_detected::${canonical}`;
  } catch {
    // Invalid URL — produce a safe fallback ID rather than throwing
    const safe = websiteUrl.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 100);
    return `website_detected::${safe}`;
  }
}

export async function createWebsiteDetectedOpportunity(
  listing: RawListing,
  websiteUrl: string,
  websiteFoundIn: "sidebar" | "profile" | "description"
): Promise<string> {
  const db = getDb();
  const now = admin.firestore.Timestamp.now();
  const listingId = listing.listingId ?? extractListingId(listing.url);
  const docId = websiteOpportunityDocId(websiteUrl);
  const docRef = db.collection("opportunities").doc(docId);

  if (env.TEST_MODE) {
    logger.info("[TEST] Website opportunity payload", {
      docId,
      listingUrl: listing.url,
      listingId,
      websiteUrl,
      websiteFoundIn,
      title: listing.title,
    });
  }

  let isNew = false;

  await db.runTransaction(async (tx) => {
    const snap = await tx.get(docRef);
    isNew = !snap.exists;

    if (isNew) {
      const opportunity: FirestoreWebsiteOpportunity = {
        listingUrl: listing.url,
        listingId,
        listingUrls: [listing.url],
        listingIds: listingId ? [listingId] : [],
        title: listing.title,
        location: listing.location ?? null,
        sellerName: listing.sellerName ?? null,
        firstName: listing.firstName ?? null,
        companyName: listing.companyName ?? null,
        rawDescription: listing.description,
        sellerProfileUrl: listing.sellerProfileUrl ?? null,
        sellerProfileUrls: listing.sellerProfileUrl ? [listing.sellerProfileUrl] : [],
        websiteUrl,
        websiteFoundIn,
        status: "website_detected",
        source: "kijiji",
        firstSeenAt: now,
        lastSeenAt: now,
        createdAt: now,
        scrapedAt: now,
        timesSeen: 1,
      };
      tx.set(docRef, opportunity);
    } else {
      // Resighting — update only sighting metadata.
      // reviewStatus, tags, status, firstSeenAt, createdAt, and all other review fields
      // on the existing document are untouched because we use update() not set().
      const sightingUpdate: Record<string, unknown> = {
        lastSeenAt: now,
        scrapedAt: now,
        timesSeen: admin.firestore.FieldValue.increment(1),
        listingUrl: listing.url,
        listingUrls: admin.firestore.FieldValue.arrayUnion(listing.url),
      };
      if (listingId) {
        sightingUpdate.listingId = listingId;
        sightingUpdate.listingIds = admin.firestore.FieldValue.arrayUnion(listingId);
      }
      if (listing.sellerProfileUrl) {
        sightingUpdate.sellerProfileUrl = listing.sellerProfileUrl;
        sightingUpdate.sellerProfileUrls = admin.firestore.FieldValue.arrayUnion(listing.sellerProfileUrl);
      }
      tx.update(docRef, sightingUpdate);
    }
  });

  if (isNew) {
    logger.info("Created website_detected opportunity", { id: docId, websiteUrl, websiteFoundIn });
  } else {
    logger.info("Updated website_detected opportunity (resighting)", { id: docId, websiteUrl });
  }

  return docId;
}
