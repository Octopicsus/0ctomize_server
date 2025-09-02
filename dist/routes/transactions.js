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
        const { type, title, description, notes, amount, originalAmount, originalCurrency, date, time, img, color } = req.body;
        if (!type || !title || !description || !amount || !originalAmount || !originalCurrency || !date || !time || !img || !color) {
            res.status(400).json({ message: 'Missing required fields' });
            return;
        }
        // Initial rule-based classification
        const baseAuto = (0, classifier_1.autoClassify)({ title, description, type: type === 'Income' ? 'Income' : 'Expense' });
        let categoryFields = baseAuto;
        // If low confidence try LLM enrichment (fire & await to keep deterministic)
        if ((baseAuto.categoryConfidence || 0) < 0.45) {
            try {
                const llm = await (0, deepseek_1.llmClassifyTransaction)(title, description, type === 'Income' ? 'Income' : 'Expense');
                if (llm) {
                    // Prefer higher confidence result
                    if ((llm.categoryConfidence || 0) >= (baseAuto.categoryConfidence || 0)) {
                        categoryFields = llm;
                    }
                }
            }
            catch (e) {
                console.warn('LLM classification skipped:', e.message);
            }
        }
        const transactionData = {
            userId: user._id,
            userEmail: user.email,
            type,
            title,
            description,
            notes,
            amount: Number(amount),
            originalAmount: Number(originalAmount),
            originalCurrency,
            date,
            time,
            img,
            color,
            ...categoryFields
        };
        const newTransaction = await transactions_1.transactionsAPI.createTransaction(transactionData);
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
            if (updatedTransaction.source === 'bank') {
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
                    });
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
