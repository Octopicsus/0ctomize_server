import { getDB } from '../middleware/database';
import { ObjectId } from 'mongodb';
import { llmClassifyTransaction, llmNormalizeMerchantTitle } from './deepseek';
import { autoClassify } from './classifier';
import { buildRawKey, hashKey, upsertGlobalPattern, incrementGlobalSupport } from './patterns';
import { mLlmCall, mEnriched, mError } from './enrichMetrics';

interface EnrichConfig {
  batchSize?: number;
  maxAttempts?: number;
  confidenceFloor?: number;
  promoteOnConfidence?: number;
}

const DEFAULTS: Required<EnrichConfig> = {
  batchSize: 20,
  maxAttempts: 3,
  confidenceFloor: 0.45,
  promoteOnConfidence: 0.6,
};

let running = false;

export async function runEnrichmentTick(cfg: EnrichConfig = {}) {
  if (running) return; // prevent overlapping ticks
  running = true;
  const opts = { ...DEFAULTS, ...cfg };
  const db = getDB();
  const txCol = db.collection('transaction');

  const now = new Date();
  // Reclaim stale processing (>5m)
  await txCol.updateMany({ enrichStatus: 'processing', enrichLockedAt: { $lt: new Date(Date.now() - 5 * 60 * 1000) } }, { $set: { enrichStatus: 'pending' }, $unset: { enrichLockedAt: '' } });

  const batch = await txCol.find({ source: 'bank', enrichStatus: { $in: [ 'pending', null ] }, enrichAttempts: { $lt: opts.maxAttempts } })
    .sort({ createdAt: 1 })
    .limit(opts.batchSize)
    .toArray();
  if (!batch.length) { running = false; return; }

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
  const norm = await llmNormalizeMerchantTitle(title, description);
  mLlmCall();
        if (norm) normalized = norm;
      } catch {}

      const rawKey = buildRawKey(normalized);
      const keyHash = hashKey(rawKey);

      // Base auto classification first
      let cat = autoClassify({ title: normalized, description, type });
      let best = cat;

      if ((cat.categoryConfidence || 0) < opts.confidenceFloor) {
        try {
          const llm = await llmClassifyTransaction(normalized, description, type);
          mLlmCall();
          if (llm && (llm.categoryConfidence || 0) >= (cat.categoryConfidence || 0)) {
            best = llm;
          }
        } catch {}
      }

      // Update transaction
      await txCol.updateOne({ _id: new ObjectId(doc._id) }, {
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
  upsertGlobalPattern({ keyHash, rawKey, canonicalTitle: normalized, category: best.category, categoryConfidence: best.categoryConfidence, categorySource: best.categorySource || 'llm' }).catch(()=>{});
      incrementGlobalSupport(keyHash, 1).catch(()=>{});
  mEnriched();
    } catch (e) {
  mError();
      await txCol.updateOne({ _id: new ObjectId(doc._id) }, {
        $inc: { enrichAttempts: 1 },
        $set: { enrichStatus: 'pending' },
        $unset: { enrichLockedAt: '' }
      });
    }
  }
  running = false;
}
