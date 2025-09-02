"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
/**
 * Deduplicate bank_transactions and related transaction documents.
 *
 * Strategy:
 * 1. Group bank_transactions by (userId, accountId, bankTxId) where count > 1.
 * 2. Keep the earliest createdAt (or first) record; remove the rest.
 * 3. For each removed bank_transactions document, if its linked transactionId is not referenced
 *    anymore by any remaining bank_transactions doc, delete that transaction.
 *
 * Safe: does NOT attempt heuristic dedupe directly in 'transaction' collection beyond link table.
 * If further cleanup needed (legacy duplicates without bank_transactions), run a separate pass.
 */
const database_1 = require("../middleware/database");
async function run() {
    const db = await (0, database_1.connectDB)();
    const linkCol = db.collection('bank_transactions');
    const txCol = db.collection('transaction');
    const cursor = linkCol.aggregate([
        { $group: { _id: { userId: '$userId', accountId: '$accountId', bankTxId: '$bankTxId' }, ids: { $push: '$_id' }, txIds: { $push: '$transactionId' }, created: { $push: '$createdAt' }, count: { $sum: 1 } } },
        { $match: { count: { $gt: 1 } } }
    ]);
    let groups = 0;
    let removedLinks = 0;
    let removedTx = 0;
    while (await cursor.hasNext()) {
        const grp = await cursor.next();
        if (!grp)
            break;
        groups++;
        const { ids, txIds, created } = grp;
        // Determine index of earliest createdAt
        let keepIdx = 0;
        if (created && created.length) {
            let min = new Date(created[0]).getTime();
            for (let i = 1; i < created.length; i++) {
                const t = new Date(created[i]).getTime();
                if (t < min) {
                    min = t;
                    keepIdx = i;
                }
            }
        }
        const keepId = ids[keepIdx];
        const removeIds = ids.filter((_, i) => i !== keepIdx);
        if (removeIds.length) {
            const res = await linkCol.deleteMany({ _id: { $in: removeIds } });
            removedLinks += res.deletedCount || 0;
            // For each removed link's transaction, check if still referenced
            for (let i = 0; i < ids.length; i++) {
                if (i === keepIdx)
                    continue;
                const txId = txIds[i];
                if (!txId)
                    continue;
                const still = await linkCol.findOne({ transactionId: txId });
                if (!still) {
                    const del = await txCol.deleteOne({ _id: txId });
                    if (del.deletedCount)
                        removedTx++;
                }
            }
        }
    }
    console.log(`Groups with duplicates: ${groups}`);
    console.log(`Removed duplicate link docs: ${removedLinks}`);
    console.log(`Removed orphaned transactions: ${removedTx}`);
    try {
        await linkCol.createIndex({ userId: 1, accountId: 1, bankTxId: 1 }, { unique: true });
        console.log('Unique index on bank_transactions(userId, accountId, bankTxId) ensured.');
    }
    catch (e) {
        console.warn('Index creation failed (possibly remaining duplicates):', e.message);
    }
    await (0, database_1.closeDB)();
}
run().catch(e => { console.error('Dedupe failed:', e); (0, database_1.closeDB)(); process.exit(1); });
