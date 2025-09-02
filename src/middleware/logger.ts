import { Request, Response, NextFunction } from 'express';

export const requestLogger = (req: Request, res: Response, next: NextFunction): void => {
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

export const responseLogger = (req: Request, res: Response, next: NextFunction): void => {
    const originalSend = res.send;
    
    res.send = function(data) {
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
