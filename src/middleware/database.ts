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
        db = client.db();
        try {
            await db.collection('transaction').createIndex({ userId: 1, createdAt: -1 });
            await db.collection('transaction').createIndex({ userId: 1, date: -1, time: -1 });
            await db.collection('transaction').createIndex({ userId: 1, bankAccountId: 1, date: -1, time: -1 });
            await db.collection('transaction').createIndex({ userId: 1, keyHash: 1 });
            try {
                await db.collection('transaction').createIndex(
                    { userId: 1, bankAccountId: 1, date: 1, amount: 1, title: 1 },
                    { unique: true, partialFilterExpression: { source: 'bank' }, name: 'uniq_bank_natural' }
                );
            } catch (ie) {
                console.warn('Natural unique index creation warning:', (ie as any)?.message);
            }
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
