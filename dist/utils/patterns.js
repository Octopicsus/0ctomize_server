"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.buildRawKey = buildRawKey;
exports.hashKey = hashKey;
exports.lookupPatterns = lookupPatterns;
exports.upsertGlobalPattern = upsertGlobalPattern;
exports.incrementGlobalSupport = incrementGlobalSupport;
exports.upsertUserOverride = upsertUserOverride;
exports.bumpUserOverrideUsage = bumpUserOverrideUsage;
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
    const userIdObj = new mongodb_1.ObjectId(userId);
    const now = new Date();
    await db.collection('tx_patterns_user').updateOne({ userId: userIdObj, keyHash }, { $setOnInsert: { createdAt: now, useCount: 0, rawKey }, $set: { updatedAt: now, rawKey, ...(override.title ? { overrideTitle: override.title } : {}), ...(override.category ? { overrideCategory: override.category } : {}) } }, { upsert: true });
}
async function bumpUserOverrideUsage(userId, keyHash) {
    const db = (0, database_1.getDB)();
    const userIdObj = new mongodb_1.ObjectId(userId);
    await db.collection('tx_patterns_user').updateOne({ userId: userIdObj, keyHash }, { $inc: { useCount: 1 }, $set: { updatedAt: new Date() } });
}
