import { MongoClient } from 'mongodb';
import dotenv from 'dotenv';

dotenv.config();

const uri = process.env.MONGO_URI as string;
if (!uri) {
    throw new Error('MONGO_URI is not defined in environment');
}

const client = new MongoClient(uri);

let db: any = null;

export const connectDB = async () => {
    try {
        await client.connect();
        // If database is specified in URI, driver uses it. Otherwise, use default db from URI or admin.
        // To maintain previous behavior, you can set dbName inside your MONGO_URI path.
        db = client.db();
        // Ensure performance indexes (idempotent – createIndex is safe to call repeatedly)
        try {
            await db.collection('transaction').createIndex({ userId: 1, createdAt: -1 });
            await db.collection('transaction').createIndex({ userId: 1, date: -1, time: -1 });
            await db.collection('transaction').createIndex({ userId: 1, bankAccountId: 1, date: -1, time: -1 });
            // For fast pattern based lookups
            await db.collection('transaction').createIndex({ userId: 1, keyHash: 1 });
            // Natural key uniqueness (bank imports): prevent duplicates by (userId, bankAccountId, date, amount, title)
            try {
                await db.collection('transaction').createIndex(
                    { userId: 1, bankAccountId: 1, date: 1, amount: 1, title: 1 },
                    { unique: true, partialFilterExpression: { source: 'bank' }, name: 'uniq_bank_natural' }
                );
            } catch (ie) {
                console.warn('Natural unique index creation warning:', (ie as any)?.message);
            }
            // Pattern collections indexes (idempotent)
            try {
                await db.collection('tx_patterns_global').createIndex({ supportCount: -1 });
                await db.collection('tx_patterns_global').createIndex({ canonicalTitle: 1 });
                await db.collection('tx_patterns_user').createIndex({ userId: 1, keyHash: 1 }, { unique: true });
                await db.collection('tx_patterns_votes').createIndex({ updatedAt: -1 });
            } catch (pe) {
                console.warn('Pattern indexes warning:', (pe as any)?.message);
            }
        } catch (e) {
            console.warn('Index creation warning:', (e as any)?.message);
        }
        return db;
    } catch (error) {
        console.error('MongoDB connection error:', error);
        throw error;
    }
};

export const getDB = () => {
    if (!db) {
        throw new Error('Database not connected. Call connectDB first.');
    }
    return db;
};

export const closeDB = async () => {
    try {
        await client.close();
    } catch (error) {
        console.error('Error closing MongoDB connection:', error);
    }
};
