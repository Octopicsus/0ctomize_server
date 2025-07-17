import { Router } from 'express';
import { authenticateToken } from '../middleware/auth';
import { 
    getUserCategories, 
    createCategory, 
    updateCategory, 
    deleteCategory 
} from '../api/categories';

const router = Router();

router.get('/', authenticateToken, getUserCategories);

router.post('/', authenticateToken, createCategory);

router.put('/:id', authenticateToken, updateCategory);

router.delete('/:id', authenticateToken, deleteCategory);

export default router;
