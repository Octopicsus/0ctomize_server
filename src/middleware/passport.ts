import passport from 'passport';
import { Strategy as LocalStrategy } from 'passport-local';
import { Strategy as JwtStrategy, ExtractJwt } from 'passport-jwt';
import bcrypt from 'bcrypt';
import { ObjectId } from 'mongodb';
import { getDB } from './database';

const JWT_SECRET = process.env.JWT_SECRET || 'secret-key';

passport.use('local', new LocalStrategy(
    {
        usernameField: 'email',
        passwordField: 'password'
    },
    async (email: string, password: string, done) => {
        try {
            email = String(email).trim().toLowerCase();
            const db = getDB();
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
                isPasswordValid = await bcrypt.compare(password, user.password);
            } catch (e) {
                // If stored hash is invalid/corrupted, do not leak; treat as incorrect
                return done(null, false, { message: 'Incorrect credentials' });
            }

            if (!isPasswordValid) {
                return done(null, false, { message: 'Incorrect credentials' });
            }
            
            return done(null, user);
        } catch (error) {
            return done(error);
        }
    }
));

passport.use('jwt', new JwtStrategy(
    {
        jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
        secretOrKey: JWT_SECRET
    },
    async (jwtPayload, done) => {
        try {
            const db = getDB();
            const users = db.collection('users');
            
            const user = await users.findOne(
                { _id: new ObjectId(jwtPayload.id) },
                { projection: { password: 0 } }
            );
            
            if (user) {
                return done(null, user);
            } else {
                return done(null, false);
            }
        } catch (error) {
            return done(error);
        }
    }
));

passport.serializeUser((user: any, done) => {
    done(null, user._id.toString());
});

passport.deserializeUser(async (id: string, done) => {
    try {
        const db = getDB();
        const users = db.collection('users');
        
        const user = await users.findOne(
            { _id: new ObjectId(id) },
            { projection: { password: 0 } }
        );
        
        done(null, user);
    } catch (error) {
        done(error);
    }
});

export default passport;
