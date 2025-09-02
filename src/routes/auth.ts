import { Router } from 'express';
import { 
    register, 
    login, 
    refreshToken as refreshTokenHandler, 
    logout,
    verify,
    googleAuth
} from '../api/auth';
import { validateRegistration, validateLogin, rateLimitAuth } from '../middleware/validation';
import { authenticateJWT } from '../middleware/auth';

const router = Router();

router.post('/register', validateRegistration, register);
router.post('/login', rateLimitAuth, validateLogin, login);
router.post('/refresh', refreshTokenHandler);
router.post('/logout', logout);
router.get('/verify', authenticateJWT, verify);
router.post('/google', googleAuth);

export default router;
