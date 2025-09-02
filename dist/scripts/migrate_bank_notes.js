/**
 * Migration: Backfill bankAccountId from legacy notes field and clear technical notes markers.
 *
 * Legacy pattern: notes = 'bank:<accountId>|tx:<transactionId>' (transactionId part may be empty)
 * New schema: transaction.bankAccountId holds accountId, notes left for user input.
 *
 * Safe to run multiple times (idempotent):
 *  - Only processes documents where (notes matches pattern AND (bankAccountId missing or different)).
 *  - Clears notes string after extracting.
 *
 * Usage:
 *  ts-node src/scripts/migrate_bank_notes.ts   (ensure MONGO_URI env var is set)
 */
// Using require to stay in CommonJS mode under ts-node without ESM package type
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { connectDB, closeDB } = require('../middleware/database');
async function run() {
    const db = await connectDB();
    const col = db.collection('transaction');
    const regex = /^bank:([^|]+)\|tx:(.*)$/;
    const cursor = col.find({ source: 'bank', notes: { $regex: '^bank:' } });
    let scanned = 0;
    let updated = 0;
    const batchOps = [];
    while (await cursor.hasNext()) {
        const doc = await cursor.next();
        if (!doc)
            break;
        scanned++;
        const m = typeof doc.notes === 'string' ? doc.notes.match(regex) : null;
        if (!m)
            continue;
        const accountId = m[1];
        if (!accountId)
            continue;
        // Only update if bankAccountId absent or different, or notes still contains technical marker
        if (doc.bankAccountId === accountId && doc.notes === '')
            continue;
        batchOps.push({
            updateOne: {
                filter: { _id: doc._id },
                update: { $set: { bankAccountId: accountId, notes: '' } }
            }
        });
        if (batchOps.length >= 500) {
            const res = await col.bulkWrite(batchOps, { ordered: false });
            updated += res.modifiedCount || 0;
            batchOps.length = 0;
            process.stdout.write(`Processed ${scanned} / updated ${updated}\n`);
        }
    }
    if (batchOps.length) {
        const res = await col.bulkWrite(batchOps, { ordered: false });
        updated += res.modifiedCount || 0;
    }
    console.log('Done. Scanned:', scanned, 'Updated:', updated);
    await closeDB();
}
run().catch(e => {
    console.error('Migration failed:', e);
    closeDB();
    process.exit(1);
});
