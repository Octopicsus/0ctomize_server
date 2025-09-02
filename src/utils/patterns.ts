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

// Normalize raw text (title + maybe creditor) into a stable key string
export function buildRawKey(input: string): string {
  let s = (input || '').toLowerCase();
  s = s.replace(/\d{4,}/g, ''); // remove long numeric sequences
  s = s.replace(/[\t\n]+/g, ' ');
  s = s.replace(/[_*`'"()\[\]{}<>]/g, ' ');
  s = s.replace(/\s{2,}/g, ' ').trim();
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

export async function upsertUserOverride(userId: string, keyHash: string, rawKey: string, override: { title?: string; category?: string }) {
  const db = getDB();
  const userIdObj = new ObjectId(userId);
  const now = new Date();
  await db.collection('tx_patterns_user').updateOne(
    { userId: userIdObj, keyHash },
    { $setOnInsert: { createdAt: now, useCount: 0, rawKey }, $set: { updatedAt: now, rawKey, ...(override.title ? { overrideTitle: override.title } : {}), ...(override.category ? { overrideCategory: override.category } : {}) } },
    { upsert: true }
  );
}

export async function bumpUserOverrideUsage(userId: string, keyHash: string) {
  const db = getDB();
  const userIdObj = new ObjectId(userId);
  await db.collection('tx_patterns_user').updateOne({ userId: userIdObj, keyHash }, { $inc: { useCount: 1 }, $set: { updatedAt: new Date() } });
}
