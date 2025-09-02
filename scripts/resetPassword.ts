import 'dotenv/config';
import bcrypt from 'bcrypt';
import { MongoClient } from 'mongodb';

const uri = process.env.MONGO_URI as string;
const emailArg = process.argv[2];
const newPass = process.argv[3];

if (!uri) {
  console.error('MONGO_URI missing');
  process.exit(1);
}
if (!emailArg || !newPass) {
  console.error('Usage: tsx scripts/resetPassword.ts <email> <newPassword>');
  process.exit(1);
}

(async () => {
  const email = String(emailArg).trim().toLowerCase();
  const client = new MongoClient(uri);
  try {
    await client.connect();
    const db = client.db();
    const users = db.collection('users');
    const user = await users.findOne({ email });
    if (!user) {
      console.error('User not found for', email);
      process.exit(2);
    }
    const hash = await bcrypt.hash(newPass, 10);
    await users.updateOne({ _id: user._id }, { $set: { password: hash, updatedAt: new Date() } });
    console.log('Password reset OK for', email);
  } finally {
    await client.close();
  }
})();
