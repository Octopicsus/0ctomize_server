interface Snapshot {
  ts: number;
  patternHitUser: number;
  patternHitGlobal: number;
  patternMiss: number;
  llmCalls: number;
  enriched: number;
  errors: number;
  patternCoverage?: number | null; 
  missRate?: number | null;        
  llmPerPattern?: number | null;  
  llmPerMiss?: number | null;      
  bulkCategoryUpdates?: number;
  userPatternCreates?: number;
  consensusPromotions?: number;
}

const metrics = {
  patternHitUser: 0,
  patternHitGlobal: 0,
  patternMiss: 0,
  llmCalls: 0,
  enriched: 0,
  errors: 0,
  bulkCategoryUpdates: 0,
  userPatternCreates: 0,
  consensusPromotions: 0,
  lastSnapshot: [] as Snapshot[],
};

export function mPatternHitUser() { metrics.patternHitUser++; }
export function mPatternHitGlobal() { metrics.patternHitGlobal++; }
export function mPatternMiss() { metrics.patternMiss++; }
export function mLlmCall() { metrics.llmCalls++; }
export function mEnriched() { metrics.enriched++; }
export function mError() { metrics.errors++; }
export function mBulkCategoryUpdates(n: number) { metrics.bulkCategoryUpdates += n; }
export function mUserPatternCreate() { metrics.userPatternCreates++; }
export function mConsensusPromotion() { metrics.consensusPromotions++; }

export function snapshotMetrics() {
  const totalPattern = metrics.patternHitUser + metrics.patternHitGlobal + metrics.patternMiss;
  const hits = metrics.patternHitUser + metrics.patternHitGlobal;
  const coverage = totalPattern > 0 ? hits / totalPattern : null;
  const missRate = totalPattern > 0 ? metrics.patternMiss / totalPattern : null;
  const llmPerPattern = totalPattern > 0 ? metrics.llmCalls / totalPattern : null;
  const llmPerMiss = metrics.patternMiss > 0 ? metrics.llmCalls / metrics.patternMiss : null;
  const snap: Snapshot = {
    ts: Date.now(),
    patternHitUser: metrics.patternHitUser,
    patternHitGlobal: metrics.patternHitGlobal,
    patternMiss: metrics.patternMiss,
    llmCalls: metrics.llmCalls,
    enriched: metrics.enriched,
    errors: metrics.errors,
  bulkCategoryUpdates: metrics.bulkCategoryUpdates,
  userPatternCreates: metrics.userPatternCreates,
  consensusPromotions: metrics.consensusPromotions,
    patternCoverage: coverage,
    missRate,
    llmPerPattern,
    llmPerMiss,
  };
  metrics.lastSnapshot.push(snap);
  if (metrics.lastSnapshot.length > 50) metrics.lastSnapshot.shift();
  return snap;
}

export function getMetrics() {
  const totalPattern = metrics.patternHitUser + metrics.patternHitGlobal + metrics.patternMiss;
  const hits = metrics.patternHitUser + metrics.patternHitGlobal;
  return { 
    ...metrics,
    derived: {
      patternCoverage: totalPattern > 0 ? hits / totalPattern : null,
      missRate: totalPattern > 0 ? metrics.patternMiss / totalPattern : null,
      llmPerPattern: totalPattern > 0 ? metrics.llmCalls / totalPattern : null,
      llmPerMiss: metrics.patternMiss > 0 ? metrics.llmCalls / metrics.patternMiss : null,
      totalPattern
    }
  };
}

// Simple moving rate (delta per min) could be computed by consumer from snapshots
export function getCoverageSummary(threshold: number = 0.75) {
  const m = getMetrics();
  const cov = m.derived.patternCoverage;
  const actionSuggested = cov !== null && cov < threshold;
  return {
    coverage: cov,
    missRate: m.derived.missRate,
    llmPerPattern: m.derived.llmPerPattern,
    llmPerMiss: m.derived.llmPerMiss,
    totalPattern: m.derived.totalPattern,
    threshold,
    suggestRuleExpansion: actionSuggested,
    hint: actionSuggested ? 'Coverage below threshold – consider adding frequent merchant regexes to EXPENSE_RULES / INCOME_RULES or rely more on patterns.' : 'Coverage healthy.'
  };
}