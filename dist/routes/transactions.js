"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const passport_1 = __importDefault(require("passport"));
const transactions_1 = require("../api/transactions");
const classifier_1 = require("../utils/classifier");
const deepseek_1 = require("../utils/deepseek");
const database_1 = require("../middleware/database");
const patterns_1 = require("../utils/patterns");
const enrichMetrics_1 = require("../utils/enrichMetrics");
const mongodb_1 = require("mongodb");
const router = (0, express_1.Router)();
const authenticateJWT = passport_1.default.authenticate('jwt', { session: false });
router.get('/', authenticateJWT, async (req, res) => {
    try {
        const user = req.user;
        if (!user?._id) {
            res.status(401).json({ message: 'User not authenticated' });
            return;
        }
        const transactions = await transactions_1.transactionsAPI.getTransactionsByUserId(user._id);
        res.json({ transactions, total: transactions.length });
    }
    catch (error) {
        console.error('Error fetching transactions:', error);
        res.status(500).json({ message: 'Internal server error' });
    }
});
router.post('/', authenticateJWT, async (req, res) => {
    try {
        const user = req.user;
        if (!user?._id) {
            res.status(401).json({ message: 'User not authenticated' });
            return;
        }
        const { type, title, description, notes, amount, originalAmount, originalCurrency, date, time, img, color, category: bodyCategory // optional manual category (canonical name) from client
         } = req.body;
        // Accept multiple possible client field names for category (robust to UI variations)
        let manualCategory = [
            bodyCategory,
            req.body.categoryId,
            req.body.selectedCategory,
            req.body.categoryTitle
        ].find(v => typeof v === 'string' && v.trim());
        // Relaxed validation to support lightweight manual input (description/img/color may be omitted by UI)
        if (!type || !title || amount == null || originalAmount == null || !originalCurrency || !date || !time) {
            res.status(400).json({ message: 'Missing required fields', required: ['type', 'title', 'amount', 'originalAmount', 'originalCurrency', 'date', 'time'] });
            return;
        }
        // Provide safe defaults
        const finalDescription = typeof description === 'string' ? description : '';
        const finalImg = img || '/img/custom_icon.svg';
        const finalColor = color || '#888888';
        // Initial rule-based classification
        let categoryFields;
        if (manualCategory && typeof manualCategory === 'string' && manualCategory.trim()) {
            categoryFields = {
                category: manualCategory.trim(),
                categoryConfidence: 1,
                categorySource: 'manual',
                categoryReason: 'user supplied',
                categoryVersion: 2
            };
        }
        else {
            const baseAuto = (0, classifier_1.autoClassify)({ title, description: finalDescription, type: type === 'Income' ? 'Income' : 'Expense' });
            categoryFields = baseAuto;
            // If low confidence try LLM enrichment (fire & await to keep deterministic)
            if ((baseAuto.categoryConfidence || 0) < 0.45) {
                try {
                    const llm = await (0, deepseek_1.llmClassifyTransaction)(title, finalDescription, type === 'Income' ? 'Income' : 'Expense');
                    if (llm && (llm.categoryConfidence || 0) >= (baseAuto.categoryConfidence || 0)) {
                        categoryFields = llm;
                    }
                }
                catch (e) {
                    console.warn('LLM classification skipped:', e.message);
                }
            }
        }
        const rawKey = (0, patterns_1.buildRawKey)(title);
        const keyHash = (0, patterns_1.hashKey)(rawKey);
        const transactionData = {
            userId: user._id,
            userEmail: user.email,
            type,
            title,
            description: finalDescription,
            notes: typeof notes === 'string' ? notes : '',
            amount: Number(amount),
            originalAmount: Number(originalAmount),
            originalCurrency,
            date,
            time,
            img: finalImg,
            color: finalColor,
            source: 'manual',
            keyHash,
            ...categoryFields
        };
        const newTransaction = await transactions_1.transactionsAPI.createTransaction(transactionData);
        if (manualCategory) {
            // This user intentionally set a category: record vote and user override
            try {
                await (0, patterns_1.upsertUserOverride)(user._id, keyHash, rawKey, { category: manualCategory, color: finalColor, img: finalImg });
                (0, enrichMetrics_1.mUserPatternCreate)();
                const vote = await (0, patterns_1.recordCategoryVote)(user._id, rawKey, manualCategory);
                if (vote.promoted)
                    (0, enrichMetrics_1.mConsensusPromotion)();
            }
            catch (e) {
                console.warn('manual pattern override failed', e.message);
            }
        }
        res.status(201).json(newTransaction);
    }
    catch (error) {
        console.error('Error creating transaction:', error);
        res.status(500).json({ message: 'Internal server error' });
    }
});
router.put('/:id', authenticateJWT, async (req, res) => {
    try {
        const user = req.user;
        if (!user?._id) {
            res.status(401).json({ message: 'User not authenticated' });
            return;
        }
        const { id } = req.params;
        const updateData = req.body;
        delete updateData._id;
        delete updateData.userId;
        delete updateData.createdAt;
        // Fetch original to detect changes
        const db = (0, database_1.getDB)();
        const txCol = db.collection('transaction');
        const original = await txCol.findOne({ _id: new mongodb_1.ObjectId(id), userId: new mongodb_1.ObjectId(user._id) });
        const updatedTransaction = await transactions_1.transactionsAPI.updateTransaction(id, user._id, updateData);
        if (!updatedTransaction) {
            res.status(404).json({ message: 'Transaction not found' });
            return;
        }
        try {
            if (updatedTransaction.source === 'bank' || updatedTransaction.source === 'manual') {
                // Build pattern key from (new title OR old title)
                const baseTitle = updatedTransaction.title || original?.title || '';
                const rawKey = (0, patterns_1.buildRawKey)(baseTitle);
                const keyHash = (0, patterns_1.hashKey)(rawKey);
                const titleChanged = original && original.title !== updatedTransaction.title;
                const categoryChanged = original && original.category !== updatedTransaction.category;
                if (titleChanged || categoryChanged) {
                    await (0, patterns_1.upsertUserOverride)(user._id, keyHash, rawKey, {
                        title: titleChanged ? updatedTransaction.title : undefined,
                        category: categoryChanged ? updatedTransaction.category : undefined,
                        color: updatedTransaction.color,
                        img: updatedTransaction.img,
                    });
                    if (categoryChanged && updatedTransaction.category) {
                        const vote = await (0, patterns_1.recordCategoryVote)(user._id, rawKey, updatedTransaction.category);
                        if (vote.promoted)
                            (0, enrichMetrics_1.mConsensusPromotion)();
                        (0, enrichMetrics_1.mUserPatternCreate)();
                    }
                    // Повышаем поддержку глобальной записи если совпало с глобальным предложением
                    if (categoryChanged && updatedTransaction.category) {
                        (0, patterns_1.incrementGlobalSupport)(keyHash, 1).catch(() => { });
                    }
                    // Сохраняем keyHash в транзакции если его не было
                    if (!updatedTransaction.keyHash) {
                        await txCol.updateOne({ _id: new mongodb_1.ObjectId(id) }, { $set: { keyHash } });
                        updatedTransaction.keyHash = keyHash;
                    }
                }
            }
        }
        catch (e) {
            console.warn('user override record failed:', e.message);
        }
        res.json(updatedTransaction);
    }
    catch (error) {
        console.error('Error updating transaction:', error);
        res.status(500).json({ message: 'Internal server error' });
    }
});
router.delete('/:id', authenticateJWT, async (req, res) => {
    try {
        const user = req.user;
        if (!user?._id) {
            res.status(401).json({ message: 'User not authenticated' });
            return;
        }
        const { id } = req.params;
        const deleted = await transactions_1.transactionsAPI.deleteTransaction(id, user._id);
        if (!deleted) {
            res.status(404).json({ message: 'Transaction not found' });
            return;
        }
        res.json({ message: 'Transaction deleted successfully' });
    }
    catch (error) {
        console.error('Error deleting transaction:', error);
        res.status(500).json({ message: 'Internal server error' });
    }
});
exports.default = router;
// --- Similar & bulk category apply endpoints ---
router.get('/similar/by-key/:id', authenticateJWT, async (req, res) => {
    try {
        const user = req.user;
        if (!user?._id) {
            res.status(401).json({ message: 'unauth' });
            return;
        }
        const { id } = req.params;
        const db = (0, database_1.getDB)();
        const txCol = db.collection('transaction');
        const tx = await txCol.findOne({ _id: new mongodb_1.ObjectId(id), userId: new mongodb_1.ObjectId(user._id) });
        if (!tx) {
            res.json({ baseId: id, total: 0, candidates: [] });
            return;
        }
        if (!tx.keyHash) {
            // Legacy transaction created before pattern keys; derive now
            const rawKey = (0, patterns_1.buildRawKey)(tx.title || '');
            const keyHash = (0, patterns_1.hashKey)(rawKey);
            await txCol.updateOne({ _id: tx._id }, { $set: { keyHash } });
            tx.keyHash = keyHash;
        }
        const list = await txCol.find({ userId: new mongodb_1.ObjectId(user._id), keyHash: tx.keyHash }).project({ _id: 1, category: 1 }).limit(100).toArray();
        res.json({ baseId: id, keyHash: tx.keyHash, total: list.length, candidates: list.map(t => ({ id: t._id.toString(), category: t.category })) });
    }
    catch (e) {
        res.status(500).json({ message: 'error', error: e.message });
    }
});
// Suggest category based on user pattern history (raw title in query ?title=)
router.get('/suggest', authenticateJWT, async (req, res) => {
    try {
        const user = req.user;
        if (!user?._id) {
            res.status(401).json({ message: 'unauth' });
            return;
        }
        const { title } = req.query;
        if (!title || typeof title !== 'string') {
            res.json({ ok: true, found: false });
            return;
        }
        const rawKey = (0, patterns_1.buildRawKey)(title);
        if (!rawKey) {
            res.json({ ok: true, found: false });
            return;
        }
        const keyHash = (0, patterns_1.hashKey)(rawKey);
        const db = (0, database_1.getDB)();
        const userPattern = await db.collection('tx_patterns_user').findOne({ userId: new mongodb_1.ObjectId(user._id), keyHash });
        if (userPattern?.overrideCategory) {
            console.log('[SUGGEST][userHit]', rawKey, userPattern.overrideCategory);
            res.json({ ok: true, found: true, category: userPattern.overrideCategory, color: userPattern.lastColor, img: userPattern.lastImg });
            return;
        }
        const global = await db.collection('tx_patterns_global').findOne({ _id: keyHash });
        if (global?.suggestedCategory) {
            console.log('[SUGGEST][globalHit]', rawKey, global.suggestedCategory);
            res.json({ ok: true, found: true, category: global.suggestedCategory });
            return;
        }
        console.log('[SUGGEST][miss]', rawKey);
        res.json({ ok: true, found: false });
    }
    catch (e) {
        res.status(500).json({ ok: false, error: e.message });
    }
});
// Debug suggestion introspection
router.get('/debug/suggest', authenticateJWT, async (req, res) => {
    try {
        const user = req.user;
        if (!user?._id) {
            res.status(401).json({ message: 'unauth' });
            return;
        }
        const { title } = req.query;
        if (!title || typeof title !== 'string') {
            res.json({ ok: true, reason: 'no-title' });
            return;
        }
        const rawKey = (0, patterns_1.buildRawKey)(title);
        const keyHash = (0, patterns_1.hashKey)(rawKey);
        const db = (0, database_1.getDB)();
        const userPattern = await db.collection('tx_patterns_user').findOne({ userId: new mongodb_1.ObjectId(user._id), keyHash });
        const global = await db.collection('tx_patterns_global').findOne({ _id: keyHash });
        res.json({ ok: true, rawKey, keyHash, userPatternExists: !!userPattern, userPattern, global });
    }
    catch (e) {
        res.status(500).json({ ok: false, error: e.message });
    }
});
// Backfill user patterns from existing manual transactions (idempotent)
router.post('/debug/backfill-user-patterns', authenticateJWT, async (req, res) => {
    try {
        const user = req.user;
        if (!user?._id) {
            res.status(401).json({ message: 'unauth' });
            return;
        }
        const db = (0, database_1.getDB)();
        const txCol = db.collection('transaction');
        const list = await txCol.find({ userId: new mongodb_1.ObjectId(user._id), source: 'manual' }).project({ title: 1, category: 1, color: 1, img: 1 }).limit(500).toArray();
        let created = 0;
        for (const t of list) {
            if (!t.title || !t.category)
                continue;
            const rawKey = (0, patterns_1.buildRawKey)(t.title);
            if (!rawKey)
                continue;
            const keyHash = (0, patterns_1.hashKey)(rawKey);
            const existing = await db.collection('tx_patterns_user').findOne({ userId: new mongodb_1.ObjectId(user._id), keyHash });
            if (existing?.overrideCategory)
                continue;
            await (0, patterns_1.upsertUserOverride)(user._id, keyHash, rawKey, { category: t.category, color: t.color, img: t.img });
            created++;
        }
        res.json({ ok: true, scanned: list.length, created });
    }
    catch (e) {
        res.status(500).json({ ok: false, error: e.message });
    }
});
router.post('/:id/category-apply', authenticateJWT, async (req, res) => {
    try {
        const user = req.user;
        if (!user?._id) {
            res.status(401).json({ message: 'unauth' });
            return;
        }
        const { id } = req.params;
        const { category, scope, createUserPattern, color, img } = req.body || {};
        if (!category || !scope) {
            res.status(400).json({ message: 'category & scope required' });
            return;
        }
        const db = (0, database_1.getDB)();
        const txCol = db.collection('transaction');
        const base = await txCol.findOne({ _id: new mongodb_1.ObjectId(id), userId: new mongodb_1.ObjectId(user._id) });
        if (!base) {
            res.status(404).json({ message: 'not found' });
            return;
        }
        const rawKey = (0, patterns_1.buildRawKey)(base.title || '');
        const keyHash = base.keyHash || (0, patterns_1.hashKey)(rawKey);
        if (!base.keyHash)
            await txCol.updateOne({ _id: base._id }, { $set: { keyHash } });
        let modified = 0;
        const commonSet = { category, categorySource: 'manual', updatedAt: new Date() };
        if (color)
            commonSet.color = color;
        if (img)
            commonSet.img = img;
        if (scope === 'one') {
            const r = await txCol.updateOne({ _id: base._id }, { $set: commonSet });
            modified = r.modifiedCount;
        }
        else if (scope === 'similar') {
            const r = await txCol.updateMany({ userId: new mongodb_1.ObjectId(user._id), keyHash }, { $set: commonSet });
            modified = r.modifiedCount;
        }
        else {
            res.status(400).json({ message: 'invalid scope' });
            return;
        }
        if (createUserPattern) {
            await (0, patterns_1.upsertUserOverride)(user._id, keyHash, rawKey, { category, color: commonSet.color, img: commonSet.img });
            (0, enrichMetrics_1.mUserPatternCreate)();
            const vote = await (0, patterns_1.recordCategoryVote)(user._id, rawKey, category);
            if (vote.promoted)
                (0, enrichMetrics_1.mConsensusPromotion)();
        }
        if (modified > 1)
            (0, enrichMetrics_1.mBulkCategoryUpdates)(modified);
        res.json({ ok: true, modified });
    }
    catch (e) {
        res.status(500).json({ message: 'error', error: e.message });
    }
});
