import cors from 'cors';

const defaultOrigins = ['http://localhost:3000', 'http://localhost:5173', 'http://localhost:3001', 'http://localhost:3003'];
const envOrigins = process.env.CLIENT_URLS?.split(',').map(o => o.trim()).filter(Boolean) || [];
const origins = envOrigins.length ? envOrigins : defaultOrigins;

export const corsOptions = {
    origin: origins,
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization']
};

export const corsMiddleware = cors(corsOptions);
