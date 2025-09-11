import { createHash } from 'node:crypto';
import { getDB } from '../middleware/database';
import { ObjectId } from 'mongodb';

export interface GlobalPatternDoc {
  _id: string; // keyHash
  keyHash: string;
  rawKey: string;
  canonicalTitle: string;
  suggestedCategory?: string;
  categoryConfidence?: number;
  categorySource?: string;
  supportCount: number;
  firstSeenAt: Date;
  updatedAt: Date;
}

export interface UserPatternDoc {
  _id?: any;
  userId: ObjectId;
  keyHash: string;
  rawKey: string;
  overrideTitle?: string;
  overrideCategory?: string;
  lockTitle?: boolean;
  lockCategory?: boolean;
  useCount: number;
  createdAt: Date;
  updatedAt: Date;
}

export function buildRawKey(input: string): string {
  let s = (input || '').toLowerCase();
  s = s.replace(/\d{4,}/g, ''); 
  s = s.replace(/[\t\n]+/g, ' ');
  s = s.replace(/[_*`'"()\[\]{}<>]/g, ' ');
  s = s.replace(/\s{2,}/g, ' ').trim();
  // Special normalization: treat all currency exchange titles as a single key
  // Examples: "Exchanged to EUR", "Exchange USD -> CZK", "Exchanged EUR"
  // Strategy: if the phrase contains the stem 'exchang', ignore currency codes/symbols and collapse to 'exchanged'
  if (s.includes('exchang')) {
    // Remove common currency codes and symbols and connectors
    s = s
      .replace(/\b(eur|usd|czk|pln|gbp|chf|sek|nok|dkk|huf|ron|uah|rub|cad|aud|nzd|jpy|cny)\b/g, ' ')
      .replace(/[€$£¥₽₴]|kč|zł|lei/gi, ' ')
      .replace(/\bto\b|->|<-|=>|<=|→|←|\/|\\/g, ' ')
      .replace(/\s{2,}/g, ' ').trim();
    s = 'exchanged';
  }
  // Normalize: 'refund from XYZ' -> 'refund from'
  if (/\brefund\s*from\b/.test(s)) {
    // Keep only the stable phrase, drop the sender to group all refunds as one key
    s = 'refund from';
  }
  return s.slice(0, 160);
}

export function hashKey(rawKey: string): string {
  return createHash('sha1').update(rawKey).digest('hex');
}

export async function lookupPatterns(userId: string, keyHash: string) {
  const db = getDB();
  const userIdObj = new ObjectId(userId);
  const userOverride = await db.collection('tx_patterns_user').findOne({ userId: userIdObj, keyHash });
  const global = await db.collection('tx_patterns_global').findOne({ _id: keyHash });
  return { userOverride, global };
}

export async function upsertGlobalPattern(params: { keyHash: string; rawKey: string; canonicalTitle: string; category?: string; categoryConfidence?: number; categorySource?: string }) {
  const db = getDB();
  const now = new Date();
  await db.collection('tx_patterns_global').updateOne(
    { _id: params.keyHash },
    { $setOnInsert: { firstSeenAt: now, supportCount: 0 }, $set: { keyHash: params.keyHash, rawKey: params.rawKey, canonicalTitle: params.canonicalTitle, suggestedCategory: params.category, categoryConfidence: params.categoryConfidence, categorySource: params.categorySource, updatedAt: now } },
    { upsert: true }
  );
}

export async function incrementGlobalSupport(keyHash: string, inc: number = 1) {
  const db = getDB();
  await db.collection('tx_patterns_global').updateOne({ _id: keyHash }, { $inc: { supportCount: inc }, $set: { updatedAt: new Date() } });
}

export async function upsertUserOverride(userId: any, keyHash: string, rawKey: string, override: { title?: string; category?: string; color?: string; img?: string }) {
  const db = getDB();
  let userIdObj: ObjectId;
  try {
    if (userId instanceof ObjectId) userIdObj = userId; else userIdObj = new ObjectId(String(userId));
  } catch {
    userIdObj = new ObjectId(); 
  }
  const now = new Date();
  await db.collection('tx_patterns_user').updateOne(
    { userId: userIdObj, keyHash },
  { $setOnInsert: { createdAt: now, useCount: 0, rawKey, keyHash }, $set: { updatedAt: now, ...(override.title ? { overrideTitle: override.title } : {}), ...(override.category ? { overrideCategory: override.category } : {}), ...(override.color ? { lastColor: override.color } : {}), ...(override.img ? { lastImg: override.img } : {}) } },
    { upsert: true }
  );
}

export async function bumpUserOverrideUsage(userId: string, keyHash: string) {
  const db = getDB();
  const userIdObj = new ObjectId(userId);
  await db.collection('tx_patterns_user').updateOne({ userId: userIdObj, keyHash }, { $inc: { useCount: 1 }, $set: { updatedAt: new Date() } });
}


const BLACKLIST_PATTERNS = ['payment', 'transfer', 'card', 'debit', 'credit']; 

export interface VoteResult {
  keyHash: string;
  leadingCategory?: string;
  leadingRatio?: number;
  totalVotes: number;
  promoted?: boolean;
}

export async function recordCategoryVote(userId: string, rawKey: string, category: string, opts: { promoteThreshold?: number; minUsers?: number; hysteresisDown?: number } = {}) {
  const promoteThreshold = opts.promoteThreshold ?? 0.8;
  const minUsers = opts.minUsers ?? 5;
  const hysteresisDown = opts.hysteresisDown ?? 0.35; 

  const keyHash = hashKey(rawKey);
  const lower = (category || '').trim();
  if (!lower) return { keyHash, totalVotes: 0 } as VoteResult;
  if (BLACKLIST_PATTERNS.includes(rawKey)) return { keyHash, totalVotes: 0 } as VoteResult;
  const db = getDB();
  const col = db.collection('tx_patterns_votes');
  const field = `votes.${lower}`;
  await col.updateOne(
    { _id: keyHash },
    { $setOnInsert: { createdAt: new Date(), users: [] }, $set: { updatedAt: new Date(), rawKey }, $inc: { [field]: 1 }, $addToSet: { users: new ObjectId(userId) } },
    { upsert: true }
  );
  const doc = await col.findOne({ _id: keyHash });
  if (!doc) return { keyHash, totalVotes: 0 } as VoteResult;
  const votes = doc.votes || {};
  let total = 0; let topCat: string | undefined; let topCount = 0;
  for (const k of Object.keys(votes)) {
    const c = votes[k];
    total += c;
    if (c > topCount) { topCount = c; topCat = k; }
  }
  const ratio = total > 0 ? topCount / total : 0;
  let promoted = false;
  if (topCat && ratio >= promoteThreshold && (doc.users?.length || 0) >= minUsers) {
    await upsertGlobalPattern({ keyHash, rawKey, canonicalTitle: rawKey.slice(0, 60), category: topCat, categoryConfidence: ratio, categorySource: 'consensus' });
    promoted = true;
  }
  return { keyHash, leadingCategory: topCat, leadingRatio: ratio, totalVotes: total, promoted } as VoteResult;
}
