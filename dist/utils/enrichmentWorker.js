"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.runEnrichmentTick = runEnrichmentTick;
const database_1 = require("../middleware/database");
const mongodb_1 = require("mongodb");
const deepseek_1 = require("./deepseek");
const classifier_1 = require("./classifier");
const patterns_1 = require("./patterns");
const enrichMetrics_1 = require("./enrichMetrics");
const DEFAULTS = {
    batchSize: 20,
    maxAttempts: 3,
    confidenceFloor: 0.45,
    promoteOnConfidence: 0.6,
};
let running = false;
async function runEnrichmentTick(cfg = {}) {
    if (running)
        return; // prevent overlapping ticks
    running = true;
    const opts = { ...DEFAULTS, ...cfg };
    const db = (0, database_1.getDB)();
    const txCol = db.collection('transaction');
    const now = new Date();
    // Reclaim stale processing (>5m)
    await txCol.updateMany({ enrichStatus: 'processing', enrichLockedAt: { $lt: new Date(Date.now() - 5 * 60 * 1000) } }, { $set: { enrichStatus: 'pending' }, $unset: { enrichLockedAt: '' } });
    const batch = await txCol.find({ source: 'bank', enrichStatus: { $in: ['pending', null] }, enrichAttempts: { $lt: opts.maxAttempts } })
        .sort({ createdAt: 1 })
        .limit(opts.batchSize)
        .toArray();
    if (!batch.length) {
        running = false;
        return;
    }
    const ids = batch.map(d => d._id);
    await txCol.updateMany({ _id: { $in: ids } }, { $set: { enrichStatus: 'processing', enrichLockedAt: now } });
    for (const doc of batch) {
        try {
            const title = doc.title || 'Bank transaction';
            const description = doc.description || '';
            const type = doc.type === 'Income' ? 'Income' : 'Expense';
            // Normalize merchant (title) via LLM
            let normalized = title;
            try {
                const norm = await (0, deepseek_1.llmNormalizeMerchantTitle)(title, description);
                (0, enrichMetrics_1.mLlmCall)();
                if (norm)
                    normalized = norm;
            }
            catch { }
            const rawKey = (0, patterns_1.buildRawKey)(normalized);
            const keyHash = (0, patterns_1.hashKey)(rawKey);
            // Base auto classification first
            let cat = (0, classifier_1.autoClassify)({ title: normalized, description, type });
            let best = cat;
            if ((cat.categoryConfidence || 0) < opts.confidenceFloor) {
                try {
                    const llm = await (0, deepseek_1.llmClassifyTransaction)(normalized, description, type);
                    (0, enrichMetrics_1.mLlmCall)();
                    if (llm && (llm.categoryConfidence || 0) >= (cat.categoryConfidence || 0)) {
                        best = llm;
                    }
                }
                catch { }
            }
            // Update transaction
            await txCol.updateOne({ _id: new mongodb_1.ObjectId(doc._id) }, {
                $set: {
                    title: normalized,
                    keyHash,
                    category: best.category,
                    categoryConfidence: best.categoryConfidence,
                    categorySource: best.categorySource || 'llm',
                    categoryReason: best.categoryReason,
                    enrichStatus: 'done',
                    enrichCompletedAt: new Date(),
                },
                $inc: { enrichAttempts: 1 },
                $unset: { enrichLockedAt: '' }
            });
            // Seed / promote pattern
            (0, patterns_1.upsertGlobalPattern)({ keyHash, rawKey, canonicalTitle: normalized, category: best.category, categoryConfidence: best.categoryConfidence, categorySource: best.categorySource || 'llm' }).catch(() => { });
            (0, patterns_1.incrementGlobalSupport)(keyHash, 1).catch(() => { });
            (0, enrichMetrics_1.mEnriched)();
        }
        catch (e) {
            (0, enrichMetrics_1.mError)();
            await txCol.updateOne({ _id: new mongodb_1.ObjectId(doc._id) }, {
                $inc: { enrichAttempts: 1 },
                $set: { enrichStatus: 'pending' },
                $unset: { enrichLockedAt: '' }
            });
        }
    }
    running = false;
}
