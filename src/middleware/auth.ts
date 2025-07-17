import { Request, Response, NextFunction } from 'express';
import passport from 'passport';
import { verifyAccessToken } from '../utils/tokens';

export interface AuthenticatedRequest extends Request {
    user?: {
        id: string;
        email: string;
    };
}

export const authenticateJWT = passport.authenticate('jwt', { session: false });

export const authenticateSession = (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    if (req.isAuthenticated()) {
        return next();
    }
    
    res.status(401).json({ message: 'Authentication required' });
};

export const authenticateToken = (req: AuthenticatedRequest, res: Response, next: NextFunction): void => {
    const authHeader = req.headers.authorization;
    if (authHeader && authHeader.startsWith('Bearer ')) {
        const token = authHeader.substring(7);
        const decoded = verifyAccessToken(token);
        
        if (decoded) {
            req.user = { id: decoded.id, email: decoded.email };
            next();
            return;
        }
    }
    
    if (req.isAuthenticated()) {
        next();
        return;
    }
    
    res.status(401).json({ message: 'Authentication required' });
};

export const requireJWT = (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    const authHeader = req.headers.authorization;
    
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
        res.status(401).json({ message: 'Bearer token required' });
        return;
    }
    
    const token = authHeader.substring(7);
    const decoded = verifyAccessToken(token);
    
    if (!decoded) {
        res.status(401).json({ message: 'Invalid or expired token' });
        return;
    }
    
    req.user = { id: decoded.id, email: decoded.email };
    next();
};
