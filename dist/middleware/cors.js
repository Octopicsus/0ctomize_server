"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.corsMiddleware = exports.corsOptions = void 0;
const cors_1 = __importDefault(require("cors"));
const defaultOrigins = ['http://localhost:3000', 'http://localhost:5173', 'http://localhost:3001', 'http://localhost:3003'];
const envOrigins = process.env.CLIENT_URLS?.split(',').map(o => o.trim()).filter(Boolean) || [];
const origins = envOrigins.length ? envOrigins : defaultOrigins;
exports.corsOptions = {
    origin: origins,
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization']
};
exports.corsMiddleware = (0, cors_1.default)(exports.corsOptions);
