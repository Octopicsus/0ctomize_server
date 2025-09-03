"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.googleAuth = void 0;
const google_auth_library_1 = require("google-auth-library");
const database_1 = require("../middleware/database");
const tokens_1 = require("../utils/tokens");
const client = new google_auth_library_1.OAuth2Client(process.env.GOOGLE_CLIENT_ID);
const googleAuth = async (req, res) => {
    try {
        const { credential } = req.body;
        if (!credential) {
            res.status(400).json({ message: 'Google credential is required' });
            return;
        }
        const ticket = await client.verifyIdToken({
            idToken: credential,
            audience: process.env.GOOGLE_CLIENT_ID,
        });
        const payload = ticket.getPayload();
        if (!payload) {
            res.status(400).json({ message: 'Invalid Google token' });
            return;
        }
        const { email, name, picture, sub: googleId } = payload;
        if (!email) {
            res.status(400).json({ message: 'Email not provided by Google' });
            return;
        }
        const db = (0, database_1.getDB)();
        const users = db.collection('users');
        let user = await users.findOne({ email });
        if (!user) {
            const newUser = {
                email,
                name: name || email.split('@')[0],
                picture,
                googleId,
                createdAt: new Date(),
                updatedAt: new Date(),
                authProvider: 'google'
            };
            const result = await users.insertOne(newUser);
            user = { ...newUser, _id: result.insertedId };
        }
        else {
            await users.updateOne({ _id: user._id }, {
                $set: {
                    googleId,
                    picture,
                    name: name || user.name,
                    updatedAt: new Date()
                }
            });
        }
        const { accessToken, refreshToken } = (0, tokens_1.generateTokens)(user._id.toString(), user.email);
        await (0, tokens_1.saveRefreshToken)(user._id.toString(), refreshToken);
        req.login(user, (err) => {
            if (err) {
                console.error('Session login error:', err);
            }
        });
        res.json({
            message: 'Google authentication successful',
            accessToken,
            refreshToken,
            user: {
                id: user._id,
                email: user.email,
                name: user.name,
                picture: user.picture,
                authProvider: 'google'
            }
        });
    }
    catch (error) {
        console.error('Google auth error:', error);
        if (error instanceof Error) {
            console.error('Error message:', error.message);
            console.error('Error stack:', error.stack);
        }
        res.status(500).json({
            message: 'Google authentication failed',
            error: error instanceof Error ? error.message : 'Unknown error'
        });
    }
};
exports.googleAuth = googleAuth;
