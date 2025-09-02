import 'dotenv/config';
import { MongoClient, ObjectId } from 'mongodb';

const uri = process.env.MONGO_URI as string;
const emailArg = process.argv[2];

if (!uri) {
  console.error('MONGO_URI missing');
  process.exit(1);
}
if (!emailArg) {
  console.error('Usage: tsx scripts/deleteUserByEmail.ts <email>');
  process.exit(1);
}

(async () => {
  const emailNorm = String(emailArg).trim().toLowerCase();
  const client = new MongoClient(uri);
  try {
    await client.connect();
    const db = client.db();
    const users = db.collection('users');
    const refreshTokens = db.collection('refresh_tokens');

    // Find users by email, case-insensitive
    const cursor = users.find({ email: emailNorm }).collation({ locale: 'en', strength: 2 });
    const exactCollation = await cursor.toArray();

    let matched = exactCollation;
    if (matched.length === 0) {
      // Fallback: regex case-insensitive (anchors ensure exact match)
      matched = await users.find({ email: { $regex: `^${emailNorm.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, $options: 'i' } }).toArray();
    }

    if (matched.length === 0) {
      console.log(JSON.stringify({ email: emailNorm, found: 0 }));
      return;
    }

    const ids = matched.map(u => (u._id as ObjectId).toString());
    const rtDel = await refreshTokens.deleteMany({ userId: { $in: ids } });
    const uDel = await users.deleteMany({ _id: { $in: matched.map(u => u._id as ObjectId) } });

    console.log(JSON.stringify({ email: emailNorm, found: matched.length, deletedUsers: uDel.deletedCount, deletedRefreshTokens: rtDel.deletedCount, ids }, null, 2));
  } catch (e) {
    console.error('Error:', e);
    process.exit(2);
  } finally {
    await client.close();
  }
})();
