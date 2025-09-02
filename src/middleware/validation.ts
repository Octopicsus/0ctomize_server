import { Request, Response, NextFunction } from 'express';

export const validateEmail = (email: string): boolean => {
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    return emailRegex.test(email);
};

export const validatePassword = (password: string): { isValid: boolean; message?: string } => {
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

export const validateRegistration = (req: Request, res: Response, next: NextFunction): void => {
    let { email, password } = req.body;
    
    if (!email || !password) {
        res.status(400).json({ 
            message: 'Email and password are required' 
        });
        return;
    }
    email = String(email).trim().toLowerCase();
    (req.body as any).email = email;
    
    if (!validateEmail(email)) {
        res.status(400).json({ 
            message: 'Invalid email format' 
        });
        return;
    }
    
    const passwordValidation = validatePassword(password);
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

export const validateLogin = (req: Request, res: Response, next: NextFunction): void => {
    let { email, password } = req.body;
    
    if (!email || !password) {
        res.status(400).json({ 
            message: 'Email and password are required' 
        });
        return;
    }
    email = String(email).trim().toLowerCase();
    (req.body as any).email = email;
    
    if (!validateEmail(email)) {
        res.status(400).json({ 
            message: 'Invalid email format' 
        });
        return;
    }
    
    next();
};

const attemptMap = new Map<string, { count: number; lastAttempt: number }>();
const windowMs = 15 * 60 * 1000; // 15 minutes
const maxAttempts = 5;

function keyFor(req: Request) {
    const ip = req.ip || (req.connection as any)?.remoteAddress || 'unknown';
    const email = (req.body?.email || req.query?.email || '').toString().trim().toLowerCase();
    return `${ip}|${email}`;
}

export const authAttempts = {
    bumpFailure(req: Request) {
        const key = keyFor(req);
        const now = Date.now();
        const prev = attemptMap.get(key);
        if (prev && now - prev.lastAttempt <= windowMs) {
            attemptMap.set(key, { count: prev.count + 1, lastAttempt: now });
        } else {
            attemptMap.set(key, { count: 1, lastAttempt: now });
        }
    },
    reset(req: Request) {
        const key = keyFor(req);
        attemptMap.delete(key);
    },
    isLimited(req: Request) {
        const key = keyFor(req);
        const now = Date.now();
        const prev = attemptMap.get(key);
        if (!prev) return false;
        if (now - prev.lastAttempt > windowMs) {
            attemptMap.delete(key);
            return false;
        }
        return prev.count >= maxAttempts;
    }
};

export const rateLimitAuth = (req: Request, res: Response, next: NextFunction): void => {
    if (authAttempts.isLimited(req)) {
        res.status(429).json({ message: 'Too many authentication attempts. Please try again later.' });
        return;
    }
    next();
};
