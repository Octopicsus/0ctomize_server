"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.buildRawKey = buildRawKey;
exports.hashKey = hashKey;
exports.lookupPatterns = lookupPatterns;
exports.upsertGlobalPattern = upsertGlobalPattern;
exports.incrementGlobalSupport = incrementGlobalSupport;
exports.upsertUserOverride = upsertUserOverride;
exports.bumpUserOverrideUsage = bumpUserOverrideUsage;
exports.recordCategoryVote = recordCategoryVote;
const node_crypto_1 = require("node:crypto");
const database_1 = require("../middleware/database");
const mongodb_1 = require("mongodb");
// Normalize raw text (title + maybe creditor) into a stable key string
function buildRawKey(input) {
    let s = (input || '').toLowerCase();
    s = s.replace(/\d{4,}/g, ''); // remove long numeric sequences
    s = s.replace(/[\t\n]+/g, ' ');
    s = s.replace(/[_*`'"()\[\]{}<>]/g, ' ');
    s = s.replace(/\s{2,}/g, ' ').trim();
    return s.slice(0, 160);
}
function hashKey(rawKey) {
    return (0, node_crypto_1.createHash)('sha1').update(rawKey).digest('hex');
}
async function lookupPatterns(userId, keyHash) {
    const db = (0, database_1.getDB)();
    const userIdObj = new mongodb_1.ObjectId(userId);
    const userOverride = await db.collection('tx_patterns_user').findOne({ userId: userIdObj, keyHash });
    const global = await db.collection('tx_patterns_global').findOne({ _id: keyHash });
    return { userOverride, global };
}
async function upsertGlobalPattern(params) {
    const db = (0, database_1.getDB)();
    const now = new Date();
    await db.collection('tx_patterns_global').updateOne({ _id: params.keyHash }, { $setOnInsert: { firstSeenAt: now, supportCount: 0 }, $set: { keyHash: params.keyHash, rawKey: params.rawKey, canonicalTitle: params.canonicalTitle, suggestedCategory: params.category, categoryConfidence: params.categoryConfidence, categorySource: params.categorySource, updatedAt: now } }, { upsert: true });
}
async function incrementGlobalSupport(keyHash, inc = 1) {
    const db = (0, database_1.getDB)();
    await db.collection('tx_patterns_global').updateOne({ _id: keyHash }, { $inc: { supportCount: inc }, $set: { updatedAt: new Date() } });
}
async function upsertUserOverride(userId, keyHash, rawKey, override) {
    const db = (0, database_1.getDB)();
    let userIdObj;
    try {
        if (userId instanceof mongodb_1.ObjectId)
            userIdObj = userId;
        else
            userIdObj = new mongodb_1.ObjectId(String(userId));
    }
    catch {
        userIdObj = new mongodb_1.ObjectId(); // fallback improbable
    }
    const now = new Date();
    await db.collection('tx_patterns_user').updateOne({ userId: userIdObj, keyHash }, { $setOnInsert: { createdAt: now, useCount: 0, rawKey }, $set: { updatedAt: now, rawKey, ...(override.title ? { overrideTitle: override.title } : {}), ...(override.category ? { overrideCategory: override.category } : {}), ...(override.color ? { lastColor: override.color } : {}), ...(override.img ? { lastImg: override.img } : {}) } }, { upsert: true });
}
async function bumpUserOverrideUsage(userId, keyHash) {
    const db = (0, database_1.getDB)();
    const userIdObj = new mongodb_1.ObjectId(userId);
    await db.collection('tx_patterns_user').updateOne({ userId: userIdObj, keyHash }, { $inc: { useCount: 1 }, $set: { updatedAt: new Date() } });
}
// --- Voting / consensus for global promotion ---
const BLACKLIST_PATTERNS = ['payment', 'transfer', 'card', 'debit', 'credit']; // overly-generic keys we skip
async function recordCategoryVote(userId, rawKey, category, opts = {}) {
    const promoteThreshold = opts.promoteThreshold ?? 0.8;
    const minUsers = opts.minUsers ?? 5;
    const hysteresisDown = opts.hysteresisDown ?? 0.35; // for future use revert logic
    const keyHash = hashKey(rawKey);
    const lower = (category || '').trim();
    if (!lower)
        return { keyHash, totalVotes: 0 };
    if (BLACKLIST_PATTERNS.includes(rawKey))
        return { keyHash, totalVotes: 0 };
    const db = (0, database_1.getDB)();
    const col = db.collection('tx_patterns_votes');
    const field = `votes.${lower}`;
    await col.updateOne({ _id: keyHash }, { $setOnInsert: { createdAt: new Date(), users: [] }, $set: { updatedAt: new Date(), rawKey }, $inc: { [field]: 1 }, $addToSet: { users: new mongodb_1.ObjectId(userId) } }, { upsert: true });
    const doc = await col.findOne({ _id: keyHash });
    if (!doc)
        return { keyHash, totalVotes: 0 };
    const votes = doc.votes || {};
    let total = 0;
    let topCat;
    let topCount = 0;
    for (const k of Object.keys(votes)) {
        const c = votes[k];
        total += c;
        if (c > topCount) {
            topCount = c;
            topCat = k;
        }
    }
    const ratio = total > 0 ? topCount / total : 0;
    let promoted = false;
    if (topCat && ratio >= promoteThreshold && (doc.users?.length || 0) >= minUsers) {
        await upsertGlobalPattern({ keyHash, rawKey, canonicalTitle: rawKey.slice(0, 60), category: topCat, categoryConfidence: ratio, categorySource: 'consensus' });
        promoted = true;
    }
    return { keyHash, leadingCategory: topCat, leadingRatio: ratio, totalVotes: total, promoted };
}
