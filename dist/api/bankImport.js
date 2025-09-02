"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.__test = void 0;
exports.importAccountTransactions = importAccountTransactions;
exports.getImportJob = getImportJob;
exports.startAsyncImport = startAsyncImport;
const database_1 = require("../middleware/database");
const mongodb_1 = require("mongodb");
const classifier_1 = require("../utils/classifier");
const patterns_1 = require("../utils/patterns");
const enrichMetrics_1 = require("../utils/enrichMetrics");
const deepseek_1 = require("../utils/deepseek");
const node_crypto_1 = require("node:crypto");
// Local mirror of category colors (should ideally be centralized / cached from client JSON)
const CATEGORY_COLOR_MAP = {
    'Groceries': '#cabd79',
    'Cafe': '#d89176',
    'Fun': '#a494d2',
    'Transport': '#7fb2c3',
    'Taxes': '#cb8169',
    'Accounting': '#9d8572',
    'Insurance': '#b089bc',
    'Rent': '#d4c580',
    'Utilities': '#d6ac7a',
    'Household': '#bfd97b',
    'Services': '#d9b178',
    'Beauty': '#e09aa8',
    'Health': '#d47b90',
    'Clothing': '#aec4dc',
    'Travel': '#89c1ba',
    'Loan': '#b47068',
    'Renovation': '#a59788',
    'Education': '#9ca4c7',
    'Other': '#c2c2c2'
};
// Minimal mapper from GoCardless transaction shape to our Transaction document
async function mapGCToTransaction(userId, userEmail, accountId, gcTx) {
    const amtStr = gcTx?.transactionAmount?.amount ?? '0';
    const amountNum = Number(amtStr);
    const currency = gcTx?.transactionAmount?.currency ?? 'EUR';
    const isExpense = amountNum < 0;
    const abs = Math.abs(amountNum);
    const remittance = gcTx?.remittanceInformationUnstructured ||
        gcTx?.remittanceInformationUnstructuredArray?.[0];
    const title = remittance ||
        gcTx?.creditorName ||
        gcTx?.debtorName ||
        'Bank transaction';
    const txCode = gcTx?.bankTransactionCode || gcTx?.proprietaryBankTransactionCode;
    // Build description but drop generic technical markers like CARD_PAYMENT from visible part
    const descriptionParts = [gcTx?.creditorName || gcTx?.debtorName, remittance, txCode]
        .filter(Boolean)
        .map((p) => p.replace(/CARD_PAYMENT/gi, '').trim());
    const description = descriptionParts.filter(Boolean).join(' | ');
    // Prefer precise datetime if provided; fallback to booking/value date
    const dt = gcTx?.bookingDateTime || gcTx?.valueDateTime;
    let date = gcTx?.bookingDate || gcTx?.valueDate || new Date().toISOString().slice(0, 10);
    let time = '00:00';
    if (typeof dt === 'string' && dt.includes('T')) {
        const [d, t] = dt.split('T');
        date = d;
        time = t.slice(0, 5);
    }
    // Short title: part before first pipe / slash if present
    const rawShort = String(title).split('|')[0].split('/')[0].trim();
    // LLM normalize merchant/service name (fallback to simple sanitization inside util)
    let shortTitle = rawShort;
    try {
        const norm = await (0, deepseek_1.llmNormalizeMerchantTitle)(rawShort, description);
        if (norm)
            shortTitle = norm;
    }
    catch { /* ignore normalization errors */ }
    // Build pattern key BEFORE classification
    const patternRawSource = title;
    const rawKey = (0, patterns_1.buildRawKey)(patternRawSource);
    const keyHash = (0, patterns_1.hashKey)(rawKey);
    const { userOverride, global } = await (0, patterns_1.lookupPatterns)(userId, keyHash);
    const base = {
        userId,
        userEmail,
        // normalize to app's expected casing
        type: isExpense ? 'Expense' : 'Income',
        title: (userOverride?.overrideTitle || global?.canonicalTitle || shortTitle).slice(0, 100),
        description: String(description).slice(0, 500),
        // Notes are now left empty for user input; previously stored technical marker bank:<accountId>|tx:<id>
        // Backward compatibility: existing transactions may still have that pattern but new ones won't.
        notes: '',
        amount: abs,
        originalAmount: abs,
        originalCurrency: currency,
        date,
        time,
        img: '/img/custom_icon.svg',
        color: '#888888',
        // mark origin for filtering in UI
        source: 'bank',
        // New explicit field to associate transaction with its bank account for incremental sync logic
        bankAccountId: accountId,
        keyHash,
        createdAt: new Date(),
        updatedAt: new Date(),
    };
    // Pre-rule overrides (exact patterns before generic rules)
    const lowerTitle = base.title.toLowerCase();
    let override = null;
    if (/exchanged to/i.test(base.description)) {
        override = { category: 'Other', categoryConfidence: 0.2, categorySource: 'override', categoryReason: 'currency exchange', categoryVersion: 2 };
    }
    else if (/refund/i.test(base.description)) {
        override = { category: 'Other', categoryConfidence: 0.3, categorySource: 'override', categoryReason: 'refund', categoryVersion: 2 };
    }
    else if (/transfer/i.test(base.description) || /transfer/i.test(lowerTitle)) {
        // direction decide: negative expense => Transfers Send, positive income => Transfers Get
        override = { category: amountNum < 0 ? 'Transfers Send' : 'Transfers Get', categoryConfidence: 0.6, categorySource: 'override', categoryReason: 'keyword transfer', categoryVersion: 2 };
    }
    // If user override category exists use it directly; else if global suggestion present use it.
    let cat = null;
    if (userOverride?.overrideCategory) {
        (0, enrichMetrics_1.mPatternHitUser)();
        cat = { category: userOverride.overrideCategory, categoryConfidence: 0.99, categorySource: 'manual', categoryReason: 'user override', categoryVersion: 2 };
        (0, patterns_1.bumpUserOverrideUsage)(userId, keyHash).catch(() => { });
    }
    else if (global?.suggestedCategory) {
        (0, enrichMetrics_1.mPatternHitGlobal)();
        cat = { category: global.suggestedCategory, categoryConfidence: global.categoryConfidence || 0.8, categorySource: global.categorySource || 'aggregate', categoryReason: 'global pattern', categoryVersion: 2 };
        (0, patterns_1.incrementGlobalSupport)(keyHash, 1).catch(() => { });
    }
    if (!cat) {
        (0, enrichMetrics_1.mPatternMiss)();
        cat = override || (0, classifier_1.autoClassify)({ title: base.title, description: base.description, type: base.type });
    }
    let finalCat = cat;
    let needsEnrich = false;
    if (!userOverride && !global && !override && (cat.categoryConfidence || 0) < 0.45) {
        // Defer enrichment to async worker
        needsEnrich = true;
    }
    else if (!global) {
        // Seed minimal global pattern if missing (even if user override exists we store canonicalTitle for others)
        (0, patterns_1.upsertGlobalPattern)({ keyHash, rawKey, canonicalTitle: shortTitle, category: finalCat.category, categoryConfidence: finalCat.categoryConfidence, categorySource: finalCat.categorySource }).catch(() => { });
    }
    const color = CATEGORY_COLOR_MAP[finalCat.category || ''] || base.color;
    return { ...base, ...finalCat, color, enrichStatus: needsEnrich ? 'pending' : 'done', enrichAttempts: needsEnrich ? 0 : undefined };
}
async function importAccountTransactions(userId, accountId, gcResponse) {
    const db = (0, database_1.getDB)();
    const users = db.collection('users');
    const txCol = db.collection('transaction');
    const bankTxCol = db.collection('bank_transactions');
    const user = await users.findOne({ _id: new mongodb_1.ObjectId(userId) });
    const userEmail = user?.email || '';
    const booked = gcResponse?.transactions?.booked || [];
    const pending = gcResponse?.transactions?.pending || [];
    const all = [...booked, ...pending];
    let imported = 0;
    const duplicates = [];
    for (const t of all) {
        const bankTxId = t?.transactionId ||
            `${t?.valueDate || ''}-${t?.bookingDate || ''}-${t?.transactionAmount?.amount || ''}-${t?.remittanceInformationUnstructured || t?.remittanceInformationUnstructuredArray?.[0] || ''}`;
        const exists = await bankTxCol.findOne({ userId: new mongodb_1.ObjectId(userId), accountId, bankTxId });
        if (exists) {
            // Orphan recovery: if link exists but original transaction document was removed, recreate it
            const linkedTxId = exists.transactionId;
            const linkedTx = linkedTxId ? await txCol.findOne({ _id: linkedTxId }) : null;
            if (linkedTx) {
                duplicates.push(bankTxId);
                continue;
            }
            else {
                // Recreate missing transaction and update link instead of treating as duplicate
                const recreated = await mapGCToTransaction(userId, userEmail, accountId, t);
                const insRe = await txCol.insertOne({ ...recreated, userId: new mongodb_1.ObjectId(userId) });
                await bankTxCol.updateOne({ _id: exists._id }, { $set: { transactionId: insRe.insertedId, recoveredAt: new Date() } });
                imported++;
                continue;
            }
        }
        const doc = await mapGCToTransaction(userId, userEmail, accountId, t);
        // Natural key duplicate guard
        const naturalDup = await txCol.findOne({ userId: new mongodb_1.ObjectId(userId), bankAccountId: accountId, date: doc.date, amount: doc.amount, title: doc.title });
        if (naturalDup) {
            duplicates.push(bankTxId);
            continue;
        }
        else {
            try {
                const ins = await txCol.insertOne({ ...doc, userId: new mongodb_1.ObjectId(userId) });
                await bankTxCol.insertOne({
                    userId: new mongodb_1.ObjectId(userId),
                    accountId,
                    bankTxId,
                    transactionId: ins.insertedId,
                    createdAt: new Date(),
                });
                imported++;
            }
            catch (dupeErr) {
                if (dupeErr?.code === 11000) {
                    duplicates.push(bankTxId);
                    continue;
                }
                else
                    throw dupeErr;
            }
        }
    }
    return { imported, duplicatesCount: duplicates.length };
}
// Dev/testing helper (no DB writes): export mapper for isolated checks
exports.__test = { mapGCToTransaction };
const importJobs = new Map();
function pruneOldJobs() {
    const now = Date.now();
    for (const [id, job] of importJobs) {
        if (now - job.updatedAt > 1000 * 60 * 10) { // 10 min TTL
            importJobs.delete(id);
        }
    }
}
function getImportJob(jobId) {
    pruneOldJobs();
    return importJobs.get(jobId);
}
async function startAsyncImport(userId, accountId, gcResponse) {
    const booked = gcResponse?.transactions?.booked || [];
    const pending = gcResponse?.transactions?.pending || [];
    const all = [...booked, ...pending];
    const job = {
        jobId: (0, node_crypto_1.randomUUID)(),
        userId,
        accountId,
        total: all.length,
        processed: 0,
        imported: 0,
        duplicatesCount: 0,
        phase: 'starting',
        startedAt: Date.now(),
        updatedAt: Date.now(),
        done: false,
    };
    importJobs.set(job.jobId, job);
    // Fire and forget async processing
    (async () => {
        try {
            const db = (0, database_1.getDB)();
            const users = db.collection('users');
            const txCol = db.collection('transaction');
            const bankTxCol = db.collection('bank_transactions');
            const user = await users.findOne({ _id: new mongodb_1.ObjectId(userId) });
            const userEmail = user?.email || '';
            job.phase = 'processing';
            job.updatedAt = Date.now();
            for (const t of all) {
                if (job.done)
                    break; // external cancellation potential (not yet implemented)
                try {
                    const bankTxId = t?.transactionId ||
                        `${t?.valueDate || ''}-${t?.bookingDate || ''}-${t?.transactionAmount?.amount || ''}-${t?.remittanceInformationUnstructured || t?.remittanceInformationUnstructuredArray?.[0] || ''}`;
                    const exists = await bankTxCol.findOne({ userId: new mongodb_1.ObjectId(userId), accountId, bankTxId });
                    if (exists) {
                        // Orphan recovery
                        const linkedTxId = exists.transactionId;
                        const linkedTx = linkedTxId ? await txCol.findOne({ _id: linkedTxId }) : null;
                        if (linkedTx) {
                            job.duplicatesCount++;
                        }
                        else {
                            const recreated = await mapGCToTransaction(userId, userEmail, accountId, t);
                            const insRe = await txCol.insertOne({ ...recreated, userId: new mongodb_1.ObjectId(userId) });
                            await bankTxCol.updateOne({ _id: exists._id }, { $set: { transactionId: insRe.insertedId, recoveredAt: new Date() } });
                            job.imported++;
                        }
                    }
                    else {
                        const doc = await mapGCToTransaction(userId, userEmail, accountId, t);
                        // Secondary guard: natural key duplicate check (same day, amount, title, account)
                        const naturalDup = await txCol.findOne({ userId: new mongodb_1.ObjectId(userId), bankAccountId: accountId, date: doc.date, amount: doc.amount, title: doc.title });
                        if (naturalDup) {
                            job.duplicatesCount++;
                        }
                        else {
                            try {
                                const ins = await txCol.insertOne({ ...doc, userId: new mongodb_1.ObjectId(userId) });
                                await bankTxCol.insertOne({
                                    userId: new mongodb_1.ObjectId(userId),
                                    accountId,
                                    bankTxId,
                                    transactionId: ins.insertedId,
                                    createdAt: new Date(),
                                });
                                job.imported++;
                            }
                            catch (dupeErr) {
                                if (dupeErr?.code === 11000) {
                                    job.duplicatesCount++;
                                }
                                else
                                    throw dupeErr;
                            }
                        }
                    }
                }
                catch (inner) {
                    // Record error but continue
                    console.warn('[asyncImport] tx error:', inner.message);
                }
                finally {
                    job.processed++;
                    job.updatedAt = Date.now();
                }
            }
            job.phase = 'completed';
            job.done = true;
            job.updatedAt = Date.now();
        }
        catch (e) {
            job.phase = 'error';
            job.error = e?.message || String(e);
            job.done = true;
            job.updatedAt = Date.now();
        }
    })();
    return job;
}
