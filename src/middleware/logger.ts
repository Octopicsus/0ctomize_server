import { Request, Response, NextFunction } from 'express';

export const requestLogger = (req: Request, res: Response, next: NextFunction): void => {
    const timestamp = new Date().toISOString();
    const method = req.method;
    const url = req.originalUrl;
    const ip = req.ip || req.connection.remoteAddress;

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
        
        if (status >= 400 && data) {
            try {
                const responseData = JSON.parse(data);
            } catch (e) {
            }
        }
        
        return originalSend.call(this, data);
    };
    
    next();
};
