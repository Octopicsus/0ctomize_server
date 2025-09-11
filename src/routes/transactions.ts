import { Router, Request, Response } from 'express';
import passport from 'passport';
import { transactionsAPI } from '../api/transactions';
import { autoClassify } from '../utils/classifier';
import { llmClassifyTransaction } from '../utils/deepseek';
import { getDB } from '../middleware/database';
import { buildRawKey, hashKey, upsertUserOverride, incrementGlobalSupport, recordCategoryVote } from '../utils/patterns';
import { mBulkCategoryUpdates, mUserPatternCreate, mConsensusPromotion } from '../utils/enrichMetrics';
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
            color,
            category: bodyCategory // optional manual category (canonical name) from client
        } = req.body;
        // Accept multiple possible client field names for category (robust to UI variations)
    const bodyKeys = Object.keys(req.body || {});
    console.log('[TX:CREATE][debug] body keys:', bodyKeys);
    let manualCategory: string | undefined = [
            bodyCategory,
            (req.body as any).categoryId,
            (req.body as any).selectedCategory,
            (req.body as any).categoryTitle
        ].find(v => typeof v === 'string' && v.trim());
    if (manualCategory) console.log('[TX:CREATE][debug] manualCategory detected =', manualCategory);
        // Relaxed validation to support lightweight manual input (description/img/color may be omitted by UI)
        if (!type || !title || amount == null || originalAmount == null || !originalCurrency || !date || !time) {
            res.status(400).json({ message: 'Missing required fields', required: ['type','title','amount','originalAmount','originalCurrency','date','time'] });
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
                categorySource: 'manual' as const,
                categoryReason: 'user supplied',
                categoryVersion: 2
            };
        } else {
            const baseAuto = autoClassify({ title, description: finalDescription, type: type === 'Income' ? 'Income' : 'Expense' });
            categoryFields = baseAuto;
            // If low confidence try LLM enrichment (fire & await to keep deterministic)
            if ((baseAuto.categoryConfidence || 0) < 0.45) {
                try {
                    const llm = await llmClassifyTransaction(
                        title,
                        finalDescription,
                        type === 'Income' ? 'Income' : 'Expense'
                    );
                    if (llm && (llm.categoryConfidence || 0) >= (baseAuto.categoryConfidence || 0)) {
                        categoryFields = llm;
                    }
                } catch (e) {
                    console.warn('LLM classification skipped:', (e as Error).message);
                }
            }
        }

    const rawKey = buildRawKey(title);
    const keyHash = hashKey(rawKey);
    const transactionData = {
            userId: user._id,
            userEmail: user.email,
            type,
            originalTitle: title, // store immutable original title for manual creations
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
            source: 'manual' as const,
            keyHash,
            ...categoryFields
        };

        const newTransaction = await transactionsAPI.createTransaction(transactionData);
    if (manualCategory) {
            // This user intentionally set a category: record vote and user override
            try {
        await upsertUserOverride(user._id, keyHash, rawKey, { category: manualCategory, color: finalColor, img: finalImg });
                console.log('[TX:CREATE][pattern-created]', rawKey, manualCategory, keyHash);
                mUserPatternCreate();
                const vote = await recordCategoryVote(user._id, rawKey, manualCategory);
                if (vote.promoted) mConsensusPromotion();
            } catch (e) { console.warn('manual pattern override failed', (e as Error).message); }
        }
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
    if ('originalTitle' in updateData) delete updateData.originalTitle; // never allow overwrite

        // Fetch original to detect changes
        const db = getDB();
        const txCol = db.collection('transaction');
        const original = await txCol.findOne({ _id: new ObjectId(id), userId: new ObjectId(user._id) });
        // If doc missing originalTitle (legacy), patch it from current title before update
        if (original && !original.originalTitle) {
            await txCol.updateOne({ _id: new ObjectId(id) }, { $set: { originalTitle: original.title } });
        }
        const updatedTransaction = await transactionsAPI.updateTransaction(id, user._id, updateData);
        
        if (!updatedTransaction) {
            res.status(404).json({ message: 'Transaction not found' });
            return;
        }

        try {
            if (updatedTransaction.source === 'bank' || updatedTransaction.source === 'manual') {
                // Build pattern key from (new title OR old title)
                const baseTitle = updatedTransaction.title || original?.title || '';
                const rawKey = buildRawKey(baseTitle);
                const keyHash = hashKey(rawKey);
                const titleChanged = original && original.title !== updatedTransaction.title;
                const categoryChanged = original && original.category !== updatedTransaction.category;
                if (titleChanged || categoryChanged) {
                    // If user explicitly changed category, mark its provenance as manual immediately
                    if (categoryChanged && updatedTransaction.category) {
                        try {
                            const dbAgain = getDB();
                            const txColAgain = dbAgain.collection('transaction');
                            await txColAgain.updateOne({ _id: new ObjectId(id) }, { $set: { categorySource: 'manual', categoryReason: 'user edit', updatedAt: new Date() } });
                            (updatedTransaction as any).categorySource = 'manual';
                            (updatedTransaction as any).categoryReason = 'user edit';
                        } catch (e) { /* ignore */ }
                    }
                    await upsertUserOverride(user._id, keyHash, rawKey, {
                        title: titleChanged ? updatedTransaction.title : undefined,
                        category: categoryChanged ? updatedTransaction.category : undefined,
                        color: updatedTransaction.color,
                        img: updatedTransaction.img,
                    });
                    if (categoryChanged && updatedTransaction.category) {
                        const vote = await recordCategoryVote(user._id, rawKey, updatedTransaction.category);
                        if (vote.promoted) mConsensusPromotion();
                        mUserPatternCreate();
                    }
                    // Повышаем поддержку глобальной записи если совпало с глобальным предложением
                    if (categoryChanged && updatedTransaction.category) {
                        incrementGlobalSupport(keyHash, 1).catch(()=>{});
                    }
                    // Обновляем keyHash, если титул поменялся и хэш отличается
                    if (titleChanged) {
                        if (!updatedTransaction.keyHash || updatedTransaction.keyHash !== keyHash) {
                            await txCol.updateOne({ _id: new ObjectId(id) }, { $set: { keyHash } });
                            (updatedTransaction as any).keyHash = keyHash;
                        }
                    } else if (!updatedTransaction.keyHash) {
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

// --- Similar & bulk category apply endpoints ---
router.get('/similar/by-key/:id', authenticateJWT, async (req: Request, res: Response): Promise<void> => {
    try {
        const user = req.user as any; if (!user?._id) { res.status(401).json({ message: 'unauth' }); return; }
        const { id } = req.params;
        const db = getDB();
        const txCol = db.collection('transaction');
        const tx = await txCol.findOne({ _id: new ObjectId(id), userId: new ObjectId(user._id) });
        if (!tx) { res.json({ baseId: id, total: 0, candidates: [] }); return; }
        if (!tx.keyHash) {
            // Legacy transaction created before pattern keys; derive now
            const rawKey = buildRawKey(tx.title || '');
            const keyHash = hashKey(rawKey);
            await txCol.updateOne({ _id: tx._id }, { $set: { keyHash } });
            (tx as any).keyHash = keyHash;
            // If it's an exchange, migrate other titles containing 'exchang' to the same hash
            if (rawKey === 'exchanged') {
                await txCol.updateMany({ userId: new ObjectId(user._id), title: { $regex: /exchang/i } }, { $set: { keyHash } });
            }
        } else {
            // Recompute with current normalization (e.g., exchange collapsing)
            const rawKey = buildRawKey(tx.title || '');
            const normalizedHash = hashKey(rawKey);
            if (normalizedHash !== tx.keyHash) {
                await txCol.updateOne({ _id: tx._id }, { $set: { keyHash: normalizedHash } });
                (tx as any).keyHash = normalizedHash;
            }
            // If it's an exchange, migrate other titles containing 'exchang' to the same hash
            if (rawKey === 'exchanged') {
                await txCol.updateMany({ userId: new ObjectId(user._id), title: { $regex: /exchang/i } }, { $set: { keyHash: (tx as any).keyHash } });
            }
        }
        // For most patterns, consider "similar" only within the same tx type (Income vs Expense),
        // but keep cross-type grouping for Exchange (rawKey === 'exchanged').
        const rawKey = buildRawKey(tx.title || '');
        const match: any = { userId: new ObjectId(user._id), keyHash: tx.keyHash };
        if (rawKey !== 'exchanged') {
            match.type = tx.type; // restrict to same side only
        }
        const list = await txCol.find(match).project({ _id: 1, category: 1 }).limit(200).toArray();
        res.json({ baseId: id, keyHash: tx.keyHash, total: list.length, candidates: list.map(t => ({ id: t._id.toString(), category: t.category })) });
    } catch (e) { res.status(500).json({ message: 'error', error: (e as Error).message }); }
});

// Suggest similar transactions by an arbitrary title (without needing a base transaction id)
router.get('/similar/by-title', authenticateJWT, async (req: Request, res: Response): Promise<void> => {
    try {
        const user = req.user as any; if (!user?._id) { res.status(401).json({ message: 'unauth' }); return; }
        const { title, type, wide } = req.query as { title?: string; type?: string; wide?: string };
        if (!title) { res.status(400).json({ message: 'title required' }); return; }
        const baseRawKey = buildRawKey(title || '');
        const baseKeyHash = hashKey(baseRawKey);
        const db = getDB();
        const txCol = db.collection('transaction');

        // If wide mode: include variants with trailing numbers (e.g. "Bolt", "Bolt 1", "Bolt 2")
        let regex: RegExp | null = null;
        if (wide === '1') {
            // Remove optional trailing number from the provided title for stem
            const stem = (title || '').trim().replace(/\s+\d{1,3}$/,'');
            const esc = stem.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            // Allow optional space + digits (1-3) at end
            regex = new RegExp('^' + esc + '(?:\\s+\\d{1,3})?$', 'i');
        }

        // Fetch candidate set (either by keyHash or by regex wide scan)
        let candidates: any[] = [];
        if (regex) {
            const match: any = { userId: new ObjectId(user._id), title: { $regex: regex } };
            if (baseRawKey !== 'exchanged' && type && (type === 'Income' || type === 'Expense')) match.type = type;
            candidates = await txCol.find(match).project({ _id: 1, title: 1, type: 1, keyHash: 1 }).limit(600).toArray();
        } else {
            const match: any = { userId: new ObjectId(user._id), keyHash: baseKeyHash };
            if (baseRawKey !== 'exchanged' && type && (type === 'Income' || type === 'Expense')) match.type = type;
            candidates = await txCol.find(match).project({ _id: 1, title: 1, type: 1, keyHash: 1 }).limit(400).toArray();
        }

        const bulkOps: any[] = [];
        const final: any[] = [];
        for (const t of candidates) {
            const rk = buildRawKey(t.title || '');
            const h = hashKey(rk);
            if (h !== t.keyHash) {
                bulkOps.push({ updateOne: { filter: { _id: t._id }, update: { $set: { keyHash: h } } } });
            }
   
            if (h === baseKeyHash) {
                final.push(t);
            } else if (regex && rk.replace(/\s+\d{1,3}$/,'') === baseRawKey.replace(/\s+\d{1,3}$/,'')) {
                final.push(t);
            }
        }
        if (bulkOps.length) await txCol.bulkWrite(bulkOps, { ordered: false });
        res.json({ baseTitle: title, rawKey: baseRawKey, keyHash: baseKeyHash, total: final.length, candidates: final.map(t => ({ id: t._id.toString(), title: t.title, type: t.type })) });
    } catch (e) { res.status(500).json({ message: 'error', error: (e as Error).message }); }
});

router.get('/suggest', authenticateJWT, async (req: Request, res: Response): Promise<void> => {
    try {
        const user = req.user as any; if (!user?._id) { res.status(401).json({ message: 'unauth' }); return; }
        const { title } = req.query as any;
        if (!title || typeof title !== 'string') { res.json({ ok: true, found: false }); return; }
        const rawKey = buildRawKey(title);
        if (!rawKey) { res.json({ ok: true, found: false }); return; }
        const keyHash = hashKey(rawKey);
        const db = getDB();
        const userPattern = await db.collection('tx_patterns_user').findOne({ userId: new ObjectId(user._id), keyHash });
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
    } catch (e) { res.status(500).json({ ok: false, error: (e as Error).message }); }
});


router.get('/debug/suggest', authenticateJWT, async (req: Request, res: Response): Promise<void> => {
    try {
        const user = req.user as any; if (!user?._id) { res.status(401).json({ message: 'unauth' }); return; }
        const { title } = req.query as any;
        if (!title || typeof title !== 'string') { res.json({ ok: true, reason: 'no-title' }); return; }
        const rawKey = buildRawKey(title);
        const keyHash = hashKey(rawKey);
        const db = getDB();
        const userPattern = await db.collection('tx_patterns_user').findOne({ userId: new ObjectId(user._id), keyHash });
        const global = await db.collection('tx_patterns_global').findOne({ _id: keyHash });
        res.json({ ok: true, rawKey, keyHash, userPatternExists: !!userPattern, userPattern, global });
    } catch (e) { res.status(500).json({ ok: false, error: (e as Error).message }); }
});

router.post('/debug/backfill-user-patterns', authenticateJWT, async (req: Request, res: Response): Promise<void> => {
    try {
        const user = req.user as any; if (!user?._id) { res.status(401).json({ message: 'unauth' }); return; }
        const db = getDB();
        const txCol = db.collection('transaction');
        const list = await txCol.find({ userId: new ObjectId(user._id), source: 'manual' }).project({ title:1, category:1, color:1, img:1 }).limit(500).toArray();
        let created = 0;
        for (const t of list) {
            if (!t.title || !t.category) continue;
            const rawKey = buildRawKey(t.title);
            if (!rawKey) continue;
            const keyHash = hashKey(rawKey);
            const existing = await db.collection('tx_patterns_user').findOne({ userId: new ObjectId(user._id), keyHash });
            if (existing?.overrideCategory) continue;
            await upsertUserOverride(user._id, keyHash, rawKey, { category: t.category, color: t.color, img: t.img });
            created++;
        }
        res.json({ ok: true, scanned: list.length, created });
    } catch (e) { res.status(500).json({ ok: false, error: (e as Error).message }); }
});

// Force create / override a user pattern for quick manual testing
router.post('/debug/force-pattern', authenticateJWT, async (req: Request, res: Response): Promise<void> => {
    try {
        const user = req.user as any; if (!user?._id) { res.status(401).json({ message: 'unauth' }); return; }
        const { title, category, color, img } = req.body || {};
        if (!title || !category) { res.status(400).json({ message: 'title & category required' }); return; }
        const rawKey = buildRawKey(title);
        const keyHash = hashKey(rawKey);
        await upsertUserOverride(user._id, keyHash, rawKey, { category, color, img });
        res.json({ ok: true, rawKey, keyHash, category });
    } catch (e) { res.status(500).json({ ok: false, error: (e as Error).message }); }
});

router.get('/debug/patterns', authenticateJWT, async (req: Request, res: Response): Promise<void> => {
    try {
        const user = req.user as any; if (!user?._id) { res.status(401).json({ message: 'unauth' }); return; }
        const db = getDB();
        const list = await db.collection('tx_patterns_user').find({ userId: new ObjectId(user._id) }).sort({ updatedAt: -1 }).limit(50).toArray();
        res.json({ ok: true, total: list.length, patterns: list.map(p => ({ rawKey: p.rawKey, keyHash: p.keyHash, category: p.overrideCategory, color: p.lastColor, img: p.lastImg })) });
    } catch (e) { res.status(500).json({ ok: false, error: (e as Error).message }); }
});

router.post('/:id/category-apply', authenticateJWT, async (req: Request, res: Response): Promise<void> => {
    try {
        const user = req.user as any; if (!user?._id) { res.status(401).json({ message: 'unauth' }); return; }
        const { id } = req.params;
        const { category, scope, createUserPattern, color, img } = req.body || {};
    console.log('[CATEGORY-APPLY][req]', { id, category, scope, createUserPattern, color, img });
        if (!category || !scope) { res.status(400).json({ message: 'category & scope required' }); return; }
        const db = getDB();
        const txCol = db.collection('transaction');
        const base = await txCol.findOne({ _id: new ObjectId(id), userId: new ObjectId(user._id) });
        if (!base) { res.status(404).json({ message: 'not found' }); return; }
        const rawKey = buildRawKey(base.title || '');

        let keyHash = hashKey(rawKey);
        if (!base.keyHash || base.keyHash !== keyHash) {
            await txCol.updateOne({ _id: base._id }, { $set: { keyHash } });
            (base as any).keyHash = keyHash;
        }

        if (rawKey === 'exchanged') {
            await txCol.updateMany({ userId: new ObjectId(user._id), title: { $regex: /exchang/i } }, { $set: { keyHash } });
        }
        let modified = 0;
        const commonSet: any = { category, categorySource: 'manual', updatedAt: new Date() };
        if (color) commonSet.color = color;
        if (img) commonSet.img = img;
        if (scope === 'one') {
            const r = await txCol.updateOne({ _id: base._id }, { $set: commonSet });
            modified = r.modifiedCount;
        } else if (scope === 'similar') {
       
            const match: any = { userId: new ObjectId(user._id), keyHash };
            if (rawKey !== 'exchanged') {
                match.type = base.type;
            }
            const r = await txCol.updateMany(match, { $set: commonSet });
            modified = r.modifiedCount;
        } else {
            res.status(400).json({ message: 'invalid scope' }); return; }

        try {
            await upsertUserOverride(user._id, keyHash, rawKey, { category, color: commonSet.color, img: commonSet.img });
            mUserPatternCreate();
            const vote = await recordCategoryVote(user._id, rawKey, category);
            if (vote.promoted) mConsensusPromotion();
            console.log('[CATEGORY-APPLY][pattern-upserted]', rawKey, category, keyHash);
        } catch (e) {
            console.warn('[CATEGORY-APPLY][pattern-failed]', (e as Error).message);
        }
        if (modified > 1) mBulkCategoryUpdates(modified);
        res.json({ ok: true, modified });
    } catch (e) { res.status(500).json({ message: 'error', error: (e as Error).message }); }
});

router.post('/bulk/title', authenticateJWT, async (req: Request, res: Response): Promise<void> => {
    try {
        const user = req.user as any; if (!user?._id) { res.status(401).json({ message: 'unauth' }); return; }
        const { ids, title } = req.body || {};
        if (!Array.isArray(ids) || !ids.length || typeof title !== 'string' || !title.trim()) {
            res.status(400).json({ message: 'ids(array) & title(string) required' }); return;
        }
        const cleanTitle = title.trim();
        const db = getDB();
        const txCol = db.collection('transaction');
        const objectIds = ids.filter(Boolean).map((id: string) => new ObjectId(id));

        const list = await txCol.find({ _id: { $in: objectIds }, userId: new ObjectId(user._id) }).project({ _id:1, title:1, originalTitle:1, source:1 }).toArray();
        if (!list.length) { res.json({ ok: true, modified: 0 }); return; }
        const bulk: any[] = [];
        const rawKeyForAll = buildRawKey(cleanTitle);
        const keyHashForAll = hashKey(rawKeyForAll);
        for (const doc of list) {
      
            const setOps: any = { title: cleanTitle, keyHash: keyHashForAll, updatedAt: new Date() };
            if (!doc.originalTitle) {
                setOps.originalTitle = doc.title; 
            }
            bulk.push({ updateOne: { filter: { _id: doc._id }, update: { $set: setOps } } });
        }
        if (bulk.length) await txCol.bulkWrite(bulk, { ordered: false });
        try {
            await upsertUserOverride(user._id, keyHashForAll, rawKeyForAll, { title: cleanTitle });
        } catch (e) { console.warn('[BULK-TITLE][pattern-failed]', (e as Error).message); }
        res.json({ ok: true, modified: bulk.length });
    } catch (e) { res.status(500).json({ message: 'error', error: (e as Error).message }); }
});
