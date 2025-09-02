"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.responseLogger = exports.requestLogger = void 0;
const requestLogger = (req, res, next) => {
    const timestamp = new Date().toISOString();
    const method = req.method;
    const url = req.originalUrl;
    const ip = req.ip || req.connection.remoteAddress;
    if (process.env.BANKDATA_DEBUG === 'true') {
        console.log(`[REQ] ${method} ${url} from ${ip} @${timestamp}`);
    }
    if (method === 'POST' && req.body) {
        const bodyToLog = { ...req.body };
        if (bodyToLog.password) {
            bodyToLog.password = '***hidden***';
        }
    }
    next();
};
exports.requestLogger = requestLogger;
const responseLogger = (req, res, next) => {
    const originalSend = res.send;
    res.send = function (data) {
        const timestamp = new Date().toISOString();
        const status = res.statusCode;
        const statusColor = status >= 400 ? 'Error 400' : status >= 300 ? 'Problem' : 'Status 300';
        if (process.env.BANKDATA_DEBUG === 'true' && status >= 400) {
            console.warn(`[RES] ${status} ${req.method} ${req.originalUrl}`);
        }
        return originalSend.call(this, data);
    };
    next();
};
exports.responseLogger = responseLogger;
