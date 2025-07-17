import express from 'express';
import dotenv from 'dotenv';
import { connectDB } from './middleware/database';
import { 
    corsMiddleware, 
    jsonMiddleware, 
    urlencodedMiddleware,
    errorHandler,
    requestLogger,
    securityHeaders,
    sessionMiddleware,
    passport
} from './middleware/index';
import { authRoutes, usersRoutes, transactionsRoutes, categoriesRoutes } from './routes';

dotenv.config();

const app = express();
const PORT = 3001;

app.use(securityHeaders);
app.use(corsMiddleware);
app.use(jsonMiddleware);
app.use(urlencodedMiddleware);
app.use(requestLogger);

app.use(sessionMiddleware);

app.use(passport.initialize());
app.use(passport.session());

app.use('/api/auth', authRoutes);
app.use('/api/users', usersRoutes);
app.use('/api/transactions', transactionsRoutes);
app.use('/api/categories', categoriesRoutes);

app.use(errorHandler);


const startServer = async () => {
    try {
        await connectDB();
        app.listen(PORT, () => {
            console.log(`Server started on port ${PORT}`);
        });
    } catch (error) {
        console.error('Server startup error:', error);
        process.exit(1);
    }
};

startServer();