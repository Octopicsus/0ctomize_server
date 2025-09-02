"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
require("dotenv/config");
const express_1 = __importDefault(require("express"));
const database_1 = require("./middleware/database");
const index_1 = require("./middleware/index");
const routes_1 = require("./routes");
const enrichmentWorker_1 = require("./utils/enrichmentWorker");
const enrichMetrics_1 = require("./utils/enrichMetrics");
const database_2 = require("./middleware/database");
const app = (0, express_1.default)();
const PORT = Number(process.env.PORT) || 3001;
// Early lightweight ping (before DB / session) for diagnosing startup hangs
app.get('/__early', (_req, res) => { res.json({ ok: true }); });
async function bootstrap() {
    console.log('[BOOT] Connecting to Mongo...');
    await (0, database_1.connectDB)();
    console.log('[BOOT] Mongo connected');
    app.use(index_1.securityHeaders);
    app.use(index_1.corsMiddleware);
    app.use(index_1.jsonMiddleware);
    app.use(index_1.urlencodedMiddleware);
    app.use(index_1.requestLogger);
    const disableSess = process.env.DISABLE_SESS === '1';
    if (disableSess) {
        console.log('[BOOT] Session DISABLED via DISABLE_SESS');
        app.use(index_1.passport.initialize());
    }
    else {
        app.use(index_1.sessionMiddleware);
        app.use(index_1.passport.initialize());
        app.use(index_1.passport.session());
    }
    app.use('/api/auth', routes_1.authRoutes);
    app.use('/api/users', routes_1.usersRoutes);
    app.use('/api/transactions', routes_1.transactionsRoutes);
    app.use('/api/categories', routes_1.categoriesRoutes);
    // Trace middleware specifically for bankdata requests
    app.use((req, _res, next) => {
        if (req.url.startsWith('/api/bankdata')) {
            console.log('[TRACE pre-bankdata]', req.method, req.url);
        }
        next();
    });
    app.use('/api/bankdata', routes_1.bankdataRoutes);
    console.log('[DEBUG] bankdata routes mounted at /api/bankdata');
    // Debug enrichment status endpoint
    app.get('/api/debug/enrich/status', async (_req, res) => {
        try {
            const db = (0, database_2.getDB)();
            const txCol = db.collection('transaction');
            const pending = await txCol.countDocuments({ enrichStatus: 'pending' });
            const processing = await txCol.countDocuments({ enrichStatus: 'processing' });
            const failed = await txCol.countDocuments({ enrichStatus: 'failed' });
            const metrics = (0, enrichMetrics_1.getMetrics)();
            res.json({ queue: { pending, processing, failed }, metrics });
        }
        catch (e) {
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
            const snap = (0, enrichMetrics_1.snapshotMetrics)();
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
            (0, enrichmentWorker_1.runEnrichmentTick)().catch(e => console.warn('[ENRICH] tick error', e.message));
        }, intervalMs).unref();
    }
    else {
        console.log('[ENRICH] Worker DISABLED via env');
    }
    // Debug: list all registered routes to help diagnose 404s
    app.get('/api/_routes', (_req, res) => {
        const list = [];
        const stack = app._router?.stack || [];
        for (const layer of stack) {
            if (layer.route && layer.route.path) {
                const methods = Object.keys(layer.route.methods || {}).filter(Boolean);
                for (const m of methods)
                    list.push({ method: m.toUpperCase(), path: layer.route.path });
            }
            else if (layer.name === 'router' && layer.handle?.stack) {
                const base = layer.regexp?.fast_star ? '*' : layer.regexp?.fast_slash ? '/' : '';
                for (const l2 of layer.handle.stack) {
                    if (l2.route && l2.route.path) {
                        const methods = Object.keys(l2.route.methods || {}).filter(Boolean);
                        for (const m of methods)
                            list.push({ method: m.toUpperCase(), path: `${base}${l2.route.path}` });
                    }
                }
            }
        }
        res.json({ routes: list });
    });
    app.get('/__ping', (_req, res) => { res.json({ ok: true, ts: Date.now() }); });
    app.use(index_1.notFoundHandler);
    app.use(index_1.errorHandler);
    app.listen(PORT, () => {
        console.log(`Server started on port ${PORT} [boot:db-before-session]`);
    });
}
bootstrap().catch(err => {
    console.error('[BOOT] Fatal error:', err);
    process.exit(1);
});
