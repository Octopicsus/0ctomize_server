"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.mPatternHitUser = mPatternHitUser;
exports.mPatternHitGlobal = mPatternHitGlobal;
exports.mPatternMiss = mPatternMiss;
exports.mLlmCall = mLlmCall;
exports.mEnriched = mEnriched;
exports.mError = mError;
exports.snapshotMetrics = snapshotMetrics;
exports.getMetrics = getMetrics;
const metrics = {
    patternHitUser: 0,
    patternHitGlobal: 0,
    patternMiss: 0,
    llmCalls: 0,
    enriched: 0,
    errors: 0,
    lastSnapshot: [],
};
function mPatternHitUser() { metrics.patternHitUser++; }
function mPatternHitGlobal() { metrics.patternHitGlobal++; }
function mPatternMiss() { metrics.patternMiss++; }
function mLlmCall() { metrics.llmCalls++; }
function mEnriched() { metrics.enriched++; }
function mError() { metrics.errors++; }
function snapshotMetrics() {
    const snap = {
        ts: Date.now(),
        patternHitUser: metrics.patternHitUser,
        patternHitGlobal: metrics.patternHitGlobal,
        patternMiss: metrics.patternMiss,
        llmCalls: metrics.llmCalls,
        enriched: metrics.enriched,
        errors: metrics.errors,
    };
    metrics.lastSnapshot.push(snap);
    if (metrics.lastSnapshot.length > 50)
        metrics.lastSnapshot.shift();
    return snap;
}
function getMetrics() {
    return { ...metrics };
}
// Simple moving rate (delta per min) could be computed by consumer from snapshots
