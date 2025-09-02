"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.googleAuth = exports.verify = exports.logout = exports.refreshToken = exports.login = exports.register = void 0;
const validation_1 = require("../middleware/validation");
const bcrypt_1 = __importDefault(require("bcrypt"));
const passport_1 = __importDefault(require("passport"));
const database_1 = require("../middleware/database");
const tokens_1 = require("../utils/tokens");
const googleAuth_1 = require("./googleAuth");
Object.defineProperty(exports, "googleAuth", { enumerable: true, get: function () { return googleAuth_1.googleAuth; } });
const register = async (req, res) => {
    try {
        let { email, password } = req.body;
        email = String(email).trim().toLowerCase();
        if (!email || !password) {
            res.status(400).json({ message: 'Email and password are required' });
            return;
        }
        const db = (0, database_1.getDB)();
        const users = db.collection('users');
        const existingUser = await users.findOne({ email });
        if (existingUser) {
            res.status(400).json({ message: 'The user already exists' });
            return;
        }
        const hashedPassword = await bcrypt_1.default.hash(password, 10);
        const newUser = {
            email,
            password: hashedPassword,
            createdAt: new Date(),
            updatedAt: new Date()
        };
        const result = await users.insertOne(newUser);
        const { accessToken, refreshToken } = (0, tokens_1.generateTokens)(result.insertedId.toString(), email);
        await (0, tokens_1.saveRefreshToken)(result.insertedId.toString(), refreshToken);
        req.login({ _id: result.insertedId, email }, (err) => {
            if (err) {
                console.error('Session login error:', err);
            }
        });
        res.status(201).json({
            message: 'User registered successfully',
            accessToken,
            refreshToken,
            user: {
                id: result.insertedId,
                email
            }
        });
    }
    catch (error) {
        console.error('Registration error:', error);
        res.status(500).json({ message: 'Internal Server Error' });
    }
};
exports.register = register;
const login = (req, res, next) => {
    if (req.body && req.body.email) {
        req.body.email = String(req.body.email).trim().toLowerCase();
    }
    passport_1.default.authenticate('local', async (err, user, info) => {
        if (err) {
            next(err);
            return;
        }
        if (!user) {
            validation_1.authAttempts.bumpFailure(req);
            res.status(400).json({
                message: info?.message || 'Incorrect credentials'
            });
            return;
        }
        try {
            const { accessToken, refreshToken } = (0, tokens_1.generateTokens)(user._id.toString(), user.email);
            await (0, tokens_1.saveRefreshToken)(user._id.toString(), refreshToken);
            req.login(user, (err) => {
                if (err) {
                    console.error('Session login error:', err);
                }
            });
            // successful login: reset failure counter
            validation_1.authAttempts.reset(req);
            res.json({
                message: 'Successful authorization',
                accessToken,
                refreshToken,
                user: {
                    id: user._id,
                    email: user.email
                }
            });
        }
        catch (error) {
            console.error('Authorization error:', error);
            res.status(500).json({ message: 'Internal Server Error' });
        }
    })(req, res, next);
};
exports.login = login;
const refreshToken = async (req, res) => {
    try {
        const { refreshToken } = req.body;
        if (!refreshToken) {
            res.status(401).json({ message: 'Refresh token is required' });
            return;
        }
        const decoded = (0, tokens_1.verifyRefreshToken)(refreshToken);
        if (!decoded) {
            res.status(401).json({ message: 'Invalid refresh token' });
            return;
        }
        const isValid = await (0, tokens_1.validateRefreshToken)(refreshToken);
        if (!isValid) {
            res.status(401).json({ message: 'Refresh token not found or expired' });
            return;
        }
        const newAccessToken = (0, tokens_1.generateAccessToken)(decoded.id, decoded.email);
        res.json({
            accessToken: newAccessToken
        });
    }
    catch (error) {
        console.error('Refresh token error:', error);
        res.status(500).json({ message: 'Internal Server Error' });
    }
};
exports.refreshToken = refreshToken;
const logout = async (req, res) => {
    try {
        const { refreshToken } = req.body;
        if (refreshToken) {
            await (0, tokens_1.removeRefreshToken)(refreshToken);
        }
        if (req.session) {
            req.session.destroy((err) => {
                if (err) {
                    console.error('Session destroy error:', err);
                    return res.status(500).json({ message: 'Could not log out' });
                }
                res.clearCookie('connect.sid');
                res.json({ message: 'Logged out successfully' });
            });
        }
        else {
            res.clearCookie('connect.sid');
            res.json({ message: 'Logged out successfully' });
        }
    }
    catch (error) {
        console.error('Logout error:', error);
        res.status(500).json({ message: 'Internal Server Error' });
    }
};
exports.logout = logout;
const verify = async (req, res) => {
    try {
        const authHeader = req.headers.authorization;
        const token = authHeader && authHeader.split(' ')[1];
        if (!token) {
            res.status(401).json({ message: 'Access token is required' });
            return;
        }
        if (req.user) {
            res.json({
                message: 'Token is valid',
                user: {
                    id: req.user._id || req.user.id,
                    email: req.user.email
                }
            });
        }
        else {
            res.status(401).json({ message: 'Invalid token' });
        }
    }
    catch (error) {
        console.error('Token verification error:', error);
        res.status(401).json({ message: 'Invalid token' });
    }
};
exports.verify = verify;
