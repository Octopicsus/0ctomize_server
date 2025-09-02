"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.rateLimitAuth = exports.authAttempts = exports.validateLogin = exports.validateRegistration = exports.validatePassword = exports.validateEmail = void 0;
const validateEmail = (email) => {
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    return emailRegex.test(email);
};
exports.validateEmail = validateEmail;
const validatePassword = (password) => {
    if (!password) {
        return { isValid: false, message: 'Password is required' };
    }
    if (password.length < 4) {
        return { isValid: false, message: 'Password must be at least 4 characters long' };
    }
    if (password.length > 255) {
        return { isValid: false, message: 'Password must be less than 255 characters' };
    }
    return { isValid: true };
};
exports.validatePassword = validatePassword;
const validateRegistration = (req, res, next) => {
    let { email, password } = req.body;
    if (!email || !password) {
        res.status(400).json({
            message: 'Email and password are required'
        });
        return;
    }
    email = String(email).trim().toLowerCase();
    req.body.email = email;
    if (!(0, exports.validateEmail)(email)) {
        res.status(400).json({
            message: 'Invalid email format'
        });
        return;
    }
    const passwordValidation = (0, exports.validatePassword)(password);
    if (!passwordValidation.isValid) {
        res.status(400).json({
            message: passwordValidation.message
        });
        return;
    }
    if (email.length > 255) {
        res.status(400).json({
            message: 'Email must be less than 255 characters'
        });
        return;
    }
    next();
};
exports.validateRegistration = validateRegistration;
const validateLogin = (req, res, next) => {
    let { email, password } = req.body;
    if (!email || !password) {
        res.status(400).json({
            message: 'Email and password are required'
        });
        return;
    }
    email = String(email).trim().toLowerCase();
    req.body.email = email;
    if (!(0, exports.validateEmail)(email)) {
        res.status(400).json({
            message: 'Invalid email format'
        });
        return;
    }
    next();
};
exports.validateLogin = validateLogin;
const attemptMap = new Map();
const windowMs = 15 * 60 * 1000; // 15 minutes
const maxAttempts = 5;
function keyFor(req) {
    const ip = req.ip || req.connection?.remoteAddress || 'unknown';
    const email = (req.body?.email || req.query?.email || '').toString().trim().toLowerCase();
    return `${ip}|${email}`;
}
exports.authAttempts = {
    bumpFailure(req) {
        const key = keyFor(req);
        const now = Date.now();
        const prev = attemptMap.get(key);
        if (prev && now - prev.lastAttempt <= windowMs) {
            attemptMap.set(key, { count: prev.count + 1, lastAttempt: now });
        }
        else {
            attemptMap.set(key, { count: 1, lastAttempt: now });
        }
    },
    reset(req) {
        const key = keyFor(req);
        attemptMap.delete(key);
    },
    isLimited(req) {
        const key = keyFor(req);
        const now = Date.now();
        const prev = attemptMap.get(key);
        if (!prev)
            return false;
        if (now - prev.lastAttempt > windowMs) {
            attemptMap.delete(key);
            return false;
        }
        return prev.count >= maxAttempts;
    }
};
const rateLimitAuth = (req, res, next) => {
    if (exports.authAttempts.isLimited(req)) {
        res.status(429).json({ message: 'Too many authentication attempts. Please try again later.' });
        return;
    }
    next();
};
exports.rateLimitAuth = rateLimitAuth;
