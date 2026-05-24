import admin from "firebase-admin";
import { env } from "../config/env.js";
import { logger } from "../utils/logger.js";
import type { FirestoreContact, FirestoreOpportunity, QualifiedLead, ScrapedListing } from "../types/lead.js";

let _db: FirebaseFirestore.Firestore | null = null;

function getDb(): FirebaseFirestore.Firestore {
  if (_db) return _db;

  if (!admin.apps.length) {
    admin.initializeApp({
      credential: admin.credential.cert({
        projectId: env.FIREBASE_PROJECT_ID,
        clientEmail: env.FIREBASE_CLIENT_EMAIL,
        privateKey: env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, "\n"),
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
    firstName: lead.outreachName,
    companyName: null,
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
    title: lead.title,
    location: lead.location,
    phone: lead.phone.e164,
    outreachMessage: lead.outreachMessage,
    outreachName: lead.outreachName,
    status: "ready",
    createdAt: now,
    expiresAt,
    source: "kijiji",
  };

  const docRef = await db.collection("opportunities").add(opportunity);
  logger.info("Created opportunity", { id: docRef.id, phone: lead.phone.e164 });
  return docRef.id;
}
