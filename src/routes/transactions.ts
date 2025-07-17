import { Router, Request, Response } from 'express';
import passport from 'passport';
import { transactionsAPI } from '../api/transactions';

const router = Router();

const authenticateJWT = passport.authenticate('jwt', { session: false });

router.get('/', authenticateJWT, async (req: Request, res: Response) => {
    try {
        const user = req.user as any;
        if (!user?._id) {
            res.status(401).json({ message: 'User not authenticated' });
            return;
        }

        const transactions = await transactionsAPI.getTransactionsByUserId(user._id);
        res.json({ transactions, total: transactions.length });
    } catch (error) {
        console.error('Error fetching transactions:', error);
        res.status(500).json({ message: 'Internal server error' });
    }
});

router.post('/', authenticateJWT, async (req: Request, res: Response) => {
    try {
        const user = req.user as any;
        if (!user?._id) {
            res.status(401).json({ message: 'User not authenticated' });
            return;
        }

        const {
            type,
            title,
            description,
            notes,
            amount,
            originalAmount,
            originalCurrency,
            date,
            time,
            img,
            color
        } = req.body;

        if (!type || !title || !description || !amount || !originalAmount || !originalCurrency || !date || !time || !img || !color) {
            res.status(400).json({ message: 'Missing required fields' });
            return;
        }

        const transactionData = {
            userId: user._id,
            userEmail: user.email,
            type,
            title,
            description,
            notes,
            amount: Number(amount),
            originalAmount: Number(originalAmount),
            originalCurrency,
            date,
            time,
            img,
            color
        };

        const newTransaction = await transactionsAPI.createTransaction(transactionData);
        res.status(201).json(newTransaction);
    } catch (error) {
        console.error('Error creating transaction:', error);
        res.status(500).json({ message: 'Internal server error' });
    }
});

router.put('/:id', authenticateJWT, async (req: Request, res: Response) => {
    try {
        const user = req.user as any;
        if (!user?._id) {
            res.status(401).json({ message: 'User not authenticated' });
            return;
        }

        const { id } = req.params;
        const updateData = req.body;

        delete updateData._id;
        delete updateData.userId;
        delete updateData.createdAt;

        const updatedTransaction = await transactionsAPI.updateTransaction(id, user._id, updateData);
        
        if (!updatedTransaction) {
            res.status(404).json({ message: 'Transaction not found' });
            return;
        }

        res.json(updatedTransaction);
    } catch (error) {
        console.error('Error updating transaction:', error);
        res.status(500).json({ message: 'Internal server error' });
    }
});

router.delete('/:id', authenticateJWT, async (req: Request, res: Response) => {
    try {
        const user = req.user as any;
        if (!user?._id) {
            res.status(401).json({ message: 'User not authenticated' });
            return;
        }

        const { id } = req.params;
        const deleted = await transactionsAPI.deleteTransaction(id, user._id);
        
        if (!deleted) {
            res.status(404).json({ message: 'Transaction not found' });
            return;
        }

        res.json({ message: 'Transaction deleted successfully' });
    } catch (error) {
        console.error('Error deleting transaction:', error);
        res.status(500).json({ message: 'Internal server error' });
    }
});

export default router;
