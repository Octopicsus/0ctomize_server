interface Snapshot {
  ts: number;
  patternHitUser: number;
  patternHitGlobal: number;
  patternMiss: number;
  llmCalls: number;
  enriched: number;
  errors: number;
}

const metrics = {
  patternHitUser: 0,
  patternHitGlobal: 0,
  patternMiss: 0,
  llmCalls: 0,
  enriched: 0,
  errors: 0,
  lastSnapshot: [] as Snapshot[],
};

export function mPatternHitUser() { metrics.patternHitUser++; }
export function mPatternHitGlobal() { metrics.patternHitGlobal++; }
export function mPatternMiss() { metrics.patternMiss++; }
export function mLlmCall() { metrics.llmCalls++; }
export function mEnriched() { metrics.enriched++; }
export function mError() { metrics.errors++; }

export function snapshotMetrics() {
  const snap: Snapshot = {
    ts: Date.now(),
    patternHitUser: metrics.patternHitUser,
    patternHitGlobal: metrics.patternHitGlobal,
    patternMiss: metrics.patternMiss,
    llmCalls: metrics.llmCalls,
    enriched: metrics.enriched,
    errors: metrics.errors,
  };
  metrics.lastSnapshot.push(snap);
  if (metrics.lastSnapshot.length > 50) metrics.lastSnapshot.shift();
  return snap;
}

export function getMetrics() {
  return { ...metrics };
}

// Simple moving rate (delta per min) could be computed by consumer from snapshots