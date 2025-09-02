import 'dotenv/config';
import express from 'express';
import { connectDB } from './middleware/database';
import {
    corsMiddleware,
    jsonMiddleware,
    urlencodedMiddleware,
    errorHandler,
    notFoundHandler,
    requestLogger,
    securityHeaders,
    sessionMiddleware,
    passport
} from './middleware/index';
import { authRoutes, usersRoutes, transactionsRoutes, categoriesRoutes, bankdataRoutes } from './routes';
import { runEnrichmentTick } from './utils/enrichmentWorker';
import { getMetrics, snapshotMetrics } from './utils/enrichMetrics';
import { getDB } from './middleware/database';

const app = express();
const PORT = Number(process.env.PORT) || 3001;

// Early lightweight ping (before DB / session) for diagnosing startup hangs
app.get('/__early', (_req: express.Request, res: express.Response) => { res.json({ ok: true }); });

async function bootstrap() {
    console.log('[BOOT] Connecting to Mongo...');
    await connectDB();
    console.log('[BOOT] Mongo connected');

    app.use(securityHeaders);
    app.use(corsMiddleware);
    app.use(jsonMiddleware);
    app.use(urlencodedMiddleware);
    app.use(requestLogger);
        const disableSess = process.env.DISABLE_SESS === '1';
        if (disableSess) {
            console.log('[BOOT] Session DISABLED via DISABLE_SESS');
            app.use(passport.initialize());
        } else {
            app.use(sessionMiddleware);
            app.use(passport.initialize());
            app.use(passport.session());
        }

    app.use('/api/auth', authRoutes);
    app.use('/api/users', usersRoutes);
    app.use('/api/transactions', transactionsRoutes);
    app.use('/api/categories', categoriesRoutes);
        // Trace middleware specifically for bankdata requests
        app.use((req: express.Request, _res: express.Response, next: express.NextFunction) => {
            if (req.url.startsWith('/api/bankdata')) {
                console.log('[TRACE pre-bankdata]', req.method, req.url);
            }
            next();
        });
    app.use('/api/bankdata', bankdataRoutes);
    console.log('[DEBUG] bankdata routes mounted at /api/bankdata');

    // Debug enrichment status endpoint
    app.get('/api/debug/enrich/status', async (_req, res) => {
        try {
            const db = getDB();
            const txCol = db.collection('transaction');
            const pending = await txCol.countDocuments({ enrichStatus: 'pending' });
            const processing = await txCol.countDocuments({ enrichStatus: 'processing' });
            const failed = await txCol.countDocuments({ enrichStatus: 'failed' });
            const metrics = getMetrics();
            res.json({ queue: { pending, processing, failed }, metrics });
        } catch (e: any) {
            res.status(500).json({ message: 'error', error: e.message });
        }
    });

    // SSE stream for enrichment metrics
    app.get('/api/debug/enrich/stream', (req, res) => {
        res.setHeader('Content-Type', 'text/event-stream');
        res.setHeader('Cache-Control', 'no-cache');
        res.setHeader('Connection', 'keep-alive');
        res.flushHeaders?.();
        const send = () => {
            const snap = snapshotMetrics();
            res.write(`event: metrics\n`);
            res.write(`data: ${JSON.stringify(snap)}\n\n`);
        };
        const interval = setInterval(send, 5000);
        send();
        req.on('close', () => { clearInterval(interval); });
    });

    // Start enrichment worker (polling) if not disabled
    if (process.env.DISABLE_ENRICH_WORKER !== '1') {
        const intervalMs = Number(process.env.ENRICH_TICK_MS || 5000);
        console.log(`[ENRICH] Worker enabled every ${intervalMs} ms`);
        setInterval(() => {
            runEnrichmentTick().catch(e => console.warn('[ENRICH] tick error', e.message));
        }, intervalMs).unref();
    } else {
        console.log('[ENRICH] Worker DISABLED via env');
    }

    // Debug: list all registered routes to help diagnose 404s
        app.get('/api/_routes', (_req: express.Request, res: express.Response) => {
            const list: Array<{ method: string; path: string }> = [];
            const stack: any[] = (app as any)._router?.stack || [];
            for (const layer of stack) {
                    if (layer.route && layer.route.path) {
                            const methods = Object.keys(layer.route.methods || {}).filter(Boolean);
                            for (const m of methods) list.push({ method: m.toUpperCase(), path: layer.route.path });
                    } else if (layer.name === 'router' && layer.handle?.stack) {
                            const base = layer.regexp?.fast_star ? '*' : layer.regexp?.fast_slash ? '/' : '';
                            for (const l2 of layer.handle.stack) {
                                    if (l2.route && l2.route.path) {
                                            const methods = Object.keys(l2.route.methods || {}).filter(Boolean);
                                            for (const m of methods) list.push({ method: m.toUpperCase(), path: `${base}${l2.route.path}` });
                                    }
                            }
                    }
            }
            res.json({ routes: list });
    });

        app.get('/__ping', (_req: express.Request, res: express.Response) => { res.json({ ok: true, ts: Date.now() }); });

    app.use(notFoundHandler);
    app.use(errorHandler);

    app.listen(PORT, () => {
        console.log(`Server started on port ${PORT} [boot:db-before-session]`);
    });
}

bootstrap().catch(err => {
    console.error('[BOOT] Fatal error:', err);
    process.exit(1);
});