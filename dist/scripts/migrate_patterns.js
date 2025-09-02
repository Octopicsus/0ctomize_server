"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
/**
 * Migration: backfill keyHash for existing bank transactions and seed global patterns.
 *
 * Steps:
 * 1. Scan transaction collection where source='bank'. For each doc:
 *    - Compute rawKey from current title.
 *    - Compute keyHash.
 *    - If missing or different -> update transaction with keyHash.
 *    - Accumulate counts of titles & categories per keyHash in memory.
 * 2. After scan, for each keyHash build global pattern:
 *    - canonicalTitle = most frequent title.
 *    - suggestedCategory = most frequent non-empty category (if clear winner).
 *    - supportCount = total occurrences.
 *
 * NOTE: User overrides cannot be reconstructed reliably (we don't know original title before edits), so we skip them here.
 * This is an approximation good enough to warm cache and reduce LLM calls.
 */
const database_1 = require("../middleware/database");
const patterns_1 = require("../utils/patterns");
async function run() {
    const db = await (0, database_1.connectDB)();
    const col = db.collection('transaction');
    const globalCol = db.collection('tx_patterns_global');
    const cursor = col.find({ source: 'bank' }, { projection: { title: 1, category: 1 } });
    const acc = new Map();
    let processed = 0;
    const bulkTxUpdates = [];
    while (await cursor.hasNext()) {
        const doc = await cursor.next();
        if (!doc)
            break;
        const title = doc.title || '';
        const rawKey = (0, patterns_1.buildRawKey)(title);
        const keyHash = (0, patterns_1.hashKey)(rawKey);
        // Update transaction doc if keyHash absent
        if (doc.keyHash !== keyHash) {
            bulkTxUpdates.push({ updateOne: { filter: { _id: doc._id }, update: { $set: { keyHash } } } });
        }
        let entry = acc.get(keyHash);
        if (!entry) {
            entry = { rawKey, titleCounts: {}, categoryCounts: {}, total: 0 };
            acc.set(keyHash, entry);
        }
        entry.total++;
        entry.titleCounts[title] = (entry.titleCounts[title] || 0) + 1;
        const category = doc.category;
        if (category)
            entry.categoryCounts[category] = (entry.categoryCounts[category] || 0) + 1;
        processed++;
        if (processed % 1000 === 0) {
            if (bulkTxUpdates.length) {
                await col.bulkWrite(bulkTxUpdates, { ordered: false });
                bulkTxUpdates.length = 0;
            }
            process.stdout.write(`Processed ${processed}\n`);
        }
    }
    if (bulkTxUpdates.length) {
        await col.bulkWrite(bulkTxUpdates, { ordered: false });
    }
    // Build global patterns
    const bulkGlobal = [];
    const now = new Date();
    for (const [keyHash, data] of acc) {
        // canonicalTitle = most frequent title
        let canonicalTitle = '';
        let maxTitle = 0;
        for (const t in data.titleCounts) {
            const c = data.titleCounts[t];
            if (c > maxTitle) {
                maxTitle = c;
                canonicalTitle = t;
            }
        }
        // suggestedCategory if clear winner (>50% of total)
        let suggestedCategory = undefined;
        let maxCat = 0;
        for (const c in data.categoryCounts) {
            const cnt = data.categoryCounts[c];
            if (cnt > maxCat) {
                maxCat = cnt;
                suggestedCategory = c;
            }
        }
        if (maxCat < data.total * 0.5)
            suggestedCategory = undefined;
        bulkGlobal.push({
            updateOne: {
                filter: { _id: keyHash },
                update: {
                    $setOnInsert: { firstSeenAt: now, supportCount: data.total },
                    $set: {
                        keyHash,
                        rawKey: data.rawKey,
                        canonicalTitle,
                        suggestedCategory,
                        categoryConfidence: suggestedCategory ? maxCat / data.total : undefined,
                        categorySource: suggestedCategory ? 'aggregate' : undefined,
                        updatedAt: now
                    }
                },
                upsert: true
            }
        });
        if (bulkGlobal.length >= 500) {
            await globalCol.bulkWrite(bulkGlobal, { ordered: false });
            bulkGlobal.length = 0;
        }
    }
    if (bulkGlobal.length) {
        await globalCol.bulkWrite(bulkGlobal, { ordered: false });
    }
    console.log('Migration complete. Transactions processed:', processed, 'Patterns:', acc.size);
    await (0, database_1.closeDB)();
}
run().catch(e => { console.error('Pattern migration failed:', e); (0, database_1.closeDB)(); process.exit(1); });
