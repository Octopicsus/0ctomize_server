"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const passport_1 = __importDefault(require("passport"));
const passport_local_1 = require("passport-local");
const passport_jwt_1 = require("passport-jwt");
const bcrypt_1 = __importDefault(require("bcrypt"));
const mongodb_1 = require("mongodb");
const database_1 = require("./database");
const JWT_SECRET = process.env.JWT_SECRET || 'secret-key';
passport_1.default.use('local', new passport_local_1.Strategy({
    usernameField: 'email',
    passwordField: 'password'
}, async (email, password, done) => {
    try {
        email = String(email).trim().toLowerCase();
        const db = (0, database_1.getDB)();
        const users = db.collection('users');
        const user = await users.findOne({ email });
        if (!user) {
            return done(null, false, { message: 'Incorrect credentials' });
        }
        if (!user.password || typeof user.password !== 'string') {
            return done(null, false, { message: 'Incorrect credentials' });
        }
        let isPasswordValid = false;
        try {
            isPasswordValid = await bcrypt_1.default.compare(password, user.password);
        }
        catch (e) {
            // If stored hash is invalid/corrupted, do not leak; treat as incorrect
            return done(null, false, { message: 'Incorrect credentials' });
        }
        if (!isPasswordValid) {
            return done(null, false, { message: 'Incorrect credentials' });
        }
        return done(null, user);
    }
    catch (error) {
        return done(error);
    }
}));
passport_1.default.use('jwt', new passport_jwt_1.Strategy({
    jwtFromRequest: passport_jwt_1.ExtractJwt.fromAuthHeaderAsBearerToken(),
    secretOrKey: JWT_SECRET
}, async (jwtPayload, done) => {
    try {
        const db = (0, database_1.getDB)();
        const users = db.collection('users');
        const user = await users.findOne({ _id: new mongodb_1.ObjectId(jwtPayload.id) }, { projection: { password: 0 } });
        if (user) {
            return done(null, user);
        }
        else {
            return done(null, false);
        }
    }
    catch (error) {
        return done(error);
    }
}));
passport_1.default.serializeUser((user, done) => {
    done(null, user._id.toString());
});
passport_1.default.deserializeUser(async (id, done) => {
    try {
        const db = (0, database_1.getDB)();
        const users = db.collection('users');
        const user = await users.findOne({ _id: new mongodb_1.ObjectId(id) }, { projection: { password: 0 } });
        done(null, user);
    }
    catch (error) {
        done(error);
    }
});
exports.default = passport_1.default;
