import { Router, Request, Response } from 'express';
import passport from 'passport';
import { transactionsAPI } from '../api/transactions';
import { autoClassify } from '../utils/classifier';
import { llmClassifyTransaction } from '../utils/deepseek';
import { getDB } from '../middleware/database';
import { buildRawKey, hashKey, upsertUserOverride, incrementGlobalSupport } from '../utils/patterns';
import { ObjectId } from 'mongodb';

const router = Router();

const authenticateJWT = passport.authenticate('jwt', { session: false });

router.get('/', authenticateJWT, async (req: Request, res: Response) => {
    try {
        const user = req.user as any;
        if (!user?._id) {
            res.status(401).json({ message: 'User not authenticated' });
            return;
        }

        const transactions = await transactionsAPI.getTransactionsByUserId(user._id);
        res.json({ transactions, total: transactions.length });
    } catch (error) {
        console.error('Error fetching transactions:', error);
        res.status(500).json({ message: 'Internal server error' });
    }
});

router.post('/', authenticateJWT, async (req: Request, res: Response) => {
    try {
        const user = req.user as any;
        if (!user?._id) {
            res.status(401).json({ message: 'User not authenticated' });
            return;
        }

        const {
            type,
            title,
            description,
            notes,
            amount,
            originalAmount,
            originalCurrency,
            date,
            time,
            img,
            color
        } = req.body;

        if (!type || !title || !description || !amount || !originalAmount || !originalCurrency || !date || !time || !img || !color) {
            res.status(400).json({ message: 'Missing required fields' });
            return;
        }

        // Initial rule-based classification
        const baseAuto = autoClassify({ title, description, type: type === 'Income' ? 'Income' : 'Expense' });
        let categoryFields = baseAuto;

        // If low confidence try LLM enrichment (fire & await to keep deterministic)
        if ((baseAuto.categoryConfidence || 0) < 0.45) {
            try {
                const llm = await llmClassifyTransaction(
                    title,
                    description,
                    type === 'Income' ? 'Income' : 'Expense'
                );
                if (llm) {
                    // Prefer higher confidence result
                    if ((llm.categoryConfidence || 0) >= (baseAuto.categoryConfidence || 0)) {
                        categoryFields = llm;
                    }
                }
            } catch (e) {
                console.warn('LLM classification skipped:', (e as Error).message);
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

        const newTransaction = await transactionsAPI.createTransaction(transactionData);
        res.status(201).json(newTransaction);
    } catch (error) {
        console.error('Error creating transaction:', error);
        res.status(500).json({ message: 'Internal server error' });
    }
});

router.put('/:id', authenticateJWT, async (req: Request, res: Response) => {
    try {
        const user = req.user as any;
        if (!user?._id) {
            res.status(401).json({ message: 'User not authenticated' });
            return;
        }

        const { id } = req.params;
        const updateData = req.body as any;

        delete updateData._id;
        delete updateData.userId;
        delete updateData.createdAt;

        // Fetch original to detect changes
        const db = getDB();
        const txCol = db.collection('transaction');
        const original = await txCol.findOne({ _id: new ObjectId(id), userId: new ObjectId(user._id) });
        const updatedTransaction = await transactionsAPI.updateTransaction(id, user._id, updateData);
        
        if (!updatedTransaction) {
            res.status(404).json({ message: 'Transaction not found' });
            return;
        }

        try {
            if (updatedTransaction.source === 'bank') {
                // Build pattern key from (new title OR old title)
                const baseTitle = updatedTransaction.title || original?.title || '';
                const rawKey = buildRawKey(baseTitle);
                const keyHash = hashKey(rawKey);
                const titleChanged = original && original.title !== updatedTransaction.title;
                const categoryChanged = original && original.category !== updatedTransaction.category;
                if (titleChanged || categoryChanged) {
                    await upsertUserOverride(user._id, keyHash, rawKey, {
                        title: titleChanged ? updatedTransaction.title : undefined,
                        category: categoryChanged ? updatedTransaction.category : undefined,
                    });
                    // Повышаем поддержку глобальной записи если совпало с глобальным предложением
                    if (categoryChanged && updatedTransaction.category) {
                        incrementGlobalSupport(keyHash, 1).catch(()=>{});
                    }
                    // Сохраняем keyHash в транзакции если его не было
                    if (!updatedTransaction.keyHash) {
                        await txCol.updateOne({ _id: new ObjectId(id) }, { $set: { keyHash } });
                        (updatedTransaction as any).keyHash = keyHash;
                    }
                }
            }
        } catch (e) {
            console.warn('user override record failed:', (e as Error).message);
        }

        res.json(updatedTransaction);
    } catch (error) {
        console.error('Error updating transaction:', error);
        res.status(500).json({ message: 'Internal server error' });
    }
});

router.delete('/:id', authenticateJWT, async (req: Request, res: Response) => {
    try {
        const user = req.user as any;
        if (!user?._id) {
            res.status(401).json({ message: 'User not authenticated' });
            return;
        }

        const { id } = req.params;
        const deleted = await transactionsAPI.deleteTransaction(id, user._id);
        
        if (!deleted) {
            res.status(404).json({ message: 'Transaction not found' });
            return;
        }

        res.json({ message: 'Transaction deleted successfully' });
    } catch (error) {
        console.error('Error deleting transaction:', error);
        res.status(500).json({ message: 'Internal server error' });
    }
});

export default router;
