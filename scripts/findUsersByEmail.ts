import 'dotenv/config';
import { MongoClient } from 'mongodb';

const uri = process.env.MONGO_URI as string;
const emailArg = process.argv[2];

if (!uri) {
  console.error('MONGO_URI missing');
  process.exit(1);
}
if (!emailArg) {
  console.error('Usage: tsx scripts/findUsersByEmail.ts <email>');
  process.exit(1);
}

(async () => {
  const emailNorm = String(emailArg).trim().toLowerCase();
  const client = new MongoClient(uri);
  try {
    await client.connect();
    const db = client.db();
    const users = db.collection('users');

    const byExact = await users.find({ email: emailNorm }).collation({ locale: 'en', strength: 2 }).toArray();
    const byRegex = await users.find({ email: { $regex: `^${emailNorm.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, $options: 'i' } }).toArray();

    console.log(JSON.stringify({ email: emailNorm, exact: byExact.map(u => ({ _id: u._id, email: u.email })), regex: byRegex.map(u => ({ _id: u._id, email: u.email })) }, null, 2));
  } finally {
    await client.close();
  }
})();
