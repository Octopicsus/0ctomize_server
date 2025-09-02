"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const auth_1 = require("../middleware/auth");
const gocardless_1 = require("../api/gocardless");
const node_dns_1 = __importDefault(require("node:dns"));
const node_https_1 = require("node:https");
const database_1 = require("../middleware/database");
const mongodb_1 = require("mongodb");
const bankImport_1 = require("../api/bankImport");
const node_fs_1 = __importDefault(require("node:fs"));
const node_path_1 = __importDefault(require("node:path"));
const router = (0, express_1.Router)();
// In-memory per-account soft throttle to avoid exceeding upstream daily limits (resets daily)
const accountCallStats = new Map();
const DAILY_SOFT_LIMIT = Number(process.env.BANKDATA_SOFT_LIMIT || 4);
function _statFor(accountId) {
    const today = new Date().toISOString().slice(0, 10);
    let s = accountCallStats.get(accountId);
    if (!s || s.day !== today) {
        s = { day: today, calls: 0 };
        accountCallStats.set(accountId, s);
    }
    return s;
}
function canCallAccount(accountId) {
    const s = _statFor(accountId);
    return s.calls < DAILY_SOFT_LIMIT;
}
function noteCall(accountId) { const s = _statFor(accountId); s.calls++; }
function note429(accountId) { const s = _statFor(accountId); s.last429 = Date.now(); }
const DEFAULT_COUNTRY = (process.env.BANKDATA_DEFAULT_COUNTRY || 'cz').toUpperCase();
const SANDBOX_DEFAULT_INSTITUTION = process.env.BANKDATA_SANDBOX_INSTITUTION || 'SANDBOXFINANCE_SFIN0000';
const REDIRECT_URL = process.env.BANKDATA_REDIRECT_URL || 'http://localhost:3001/api/bankdata/callback';
const IS_SANDBOX = (process.env.GOCARDLESS_SECRET_KEY || '').startsWith('sandbox_');
// Auto-sync configuration
const AUTO_ON_DEMAND_MIN_AGE_MIN = Number(process.env.BANKDATA_AUTO_ON_DEMAND_MIN_AGE_MIN || 20); // trigger if older than 20 min
const AUTO_MORNING_HOUR = Number(process.env.BANKDATA_AUTO_MORNING_HOUR || 6); // 6 AM server time
let lastMorningRunDay = null;
// Periodic lightweight scheduler (runs every 5 minutes) to perform morning catch-up sync
setInterval(async () => {
    try {
        const now = new Date();
        const day = now.toISOString().slice(0, 10);
        if (now.getHours() === AUTO_MORNING_HOUR && lastMorningRunDay !== day) {
            const db = (0, database_1.getDB)();
            const acctCol = db.collection('bank_accounts');
            const threshold = Date.now() - 1000 * 60 * 60 * 12; // 12h
            const stale = await acctCol.find({ lastSync: { $lt: new Date(threshold) } }).limit(50).toArray();
            for (const s of stale) {
                // Fire async import if possible (ignore errors)
                try {
                    const userId = s.userId?.toString();
                    if (!userId)
                        continue;
                    if (!canCallAccount(s.accountId))
                        continue; // respect daily cap
                    noteCall(s.accountId);
                    const data = await (0, gocardless_1.getAccountTransactions)(s.accountId, {});
                    await (0, bankImport_1.startAsyncImport)(userId, s.accountId, data);
                    await acctCol.updateOne({ _id: s._id }, { $set: { lastSyncQueuedAt: new Date() } });
                }
                catch (e) { /* ignore */ }
            }
            lastMorningRunDay = day;
        }
    }
    catch (e) { /* silent */ }
}, 1000 * 60 * 5);
router.get('/_ping', (req, res) => {
    res.json({ ok: true, route: 'bankdata' });
});
// Debug: current per-account call counters (auth required to avoid leaking IDs).
router.get('/debug/account-calls', auth_1.authenticateToken, (_req, res) => {
    try {
        const entries = [];
        for (const [accountId, stat] of accountCallStats.entries()) {
            entries.push({ accountId, day: stat.day, calls: stat.calls, last429: stat.last429 || null, remaining: Math.max(0, DAILY_SOFT_LIMIT - stat.calls) });
        }
        res.json({ softLimit: DAILY_SOFT_LIMIT, accounts: entries });
    }
    catch (e) {
        res.status(500).json({ message: 'Failed to read counters', error: e?.message || String(e) });
    }
});
// Simple echo route for low-level diagnostics (no auth)
router.get('/_echo', (req, res) => {
    console.log('[ECHO HIT] headers:', Object.keys(req.headers));
    res.json({ ok: true, echo: true, ts: Date.now() });
});
// Quick env debug: shows mode and key config (no secrets)
router.get('/debug/env', (_req, res) => {
    const sid = (process.env.GOCARDLESS_SECRET_ID || '').trim();
    const secretIdMasked = sid ? `${sid.slice(0, 4)}...${sid.slice(-4)}` : null;
    const sk = (process.env.GOCARDLESS_SECRET_KEY || '').trim();
    res.json({
        ok: true,
        mode: IS_SANDBOX ? 'sandbox' : 'live',
        defaultCountry: DEFAULT_COUNTRY,
        redirectUrl: REDIRECT_URL,
        sandboxDefaultInstitution: SANDBOX_DEFAULT_INSTITUTION,
        isSandboxKey: IS_SANDBOX,
        secretIdMasked,
        secretKeyLength: sk ? sk.length : 0
    });
});
// DEBUG (без аутентификации): быстрая проверка /institutions, помогает локально диагностировать 500
router.get('/debug/institutions', async (req, res) => {
    try {
        const country = (req.query.country || DEFAULT_COUNTRY).toUpperCase();
        const list = await (0, gocardless_1.listInstitutions)(country);
        const q = req.query.q?.toLowerCase().trim();
        const all = req.query.all === '1' || req.query.all === 'true';
        const limit = Math.min(Number(req.query.limit) || 20, 500);
        const filtered = q
            ? (list || []).filter((i) => (i.name || '').toLowerCase().includes(q) || (i.id || '').toLowerCase().includes(q))
            : list || [];
        const payload = all ? filtered : filtered.slice(0, limit);
        res.json({ ok: true, country, count: Array.isArray(list) ? list.length : 0, returned: payload.length, items: payload });
    }
    catch (e) {
        res.status(500).json({ ok: false, error: e?.message || String(e) });
    }
});
// Debug token cache
router.get('/debug/token', (_req, res) => {
    try {
        res.json({ ok: true, token: gocardless_1.__gocardlessDebug.tokenState() });
    }
    catch (e) {
        res.status(500).json({ ok: false, error: e?.message || String(e) });
    }
});
router.post('/debug/newtoken', async (_req, res) => {
    try {
        const meta = await (0, gocardless_1.debugObtainTokenMeta)();
        res.json({ ok: true, meta });
    }
    catch (e) {
        res.status(500).json({ ok: false, error: e?.message || String(e) });
    }
});
// Simple network ping (DNS + HEAD) to GoCardless host
router.get('/debug/net', async (_req, res) => {
    const host = 'bankaccountdata.gocardless.com';
    const started = Date.now();
    node_dns_1.default.lookup(host, (err, address) => {
        const dnsMs = Date.now() - started;
        if (err)
            return res.status(500).json({ ok: false, stage: 'dns', error: err.message });
        const req = (0, node_https_1.request)({ host, path: '/api/v2/status/', method: 'GET', timeout: 5000 }, (r) => {
            const code = r.statusCode;
            r.resume();
            res.json({ ok: true, dns: { address, ms: dnsMs }, http: { code } });
        });
        req.on('error', (e) => res.status(500).json({ ok: false, stage: 'http', error: e.message }));
        req.on('timeout', () => { req.destroy(new Error('timeout')); });
        req.end();
    });
});
// Debug: список requisitions текущего пользователя (auth required)
router.get('/debug/requisitions', auth_1.authenticateToken, async (req, res) => {
    try {
        const user = req.user;
        const db = (0, database_1.getDB)();
        const list = await db.collection('bank_requisitions')
            .find({ userId: new mongodb_1.ObjectId(user.id) })
            .project({ _id: 0 })
            .sort({ createdAt: -1 })
            .toArray();
        res.json({ ok: true, count: list.length, requisitions: list });
    }
    catch (e) {
        res.status(500).json({ ok: false, error: e?.message || String(e) });
    }
});
router.get('/institutions', auth_1.authenticateToken, async (req, res) => {
    try {
        const country = (req.query.country || DEFAULT_COUNTRY).toUpperCase();
        const institutions = await (0, gocardless_1.listInstitutions)(country);
        res.json({ institutions });
    }
    catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        console.error('bankdata/institutions error:', msg);
        // Классифицируем 401 от GoCardless (невалидные секреты / отключенный аккаунт)
        if (/GoCardless API error 401/.test(msg)) {
            res.status(502).json({
                message: 'Upstream authentication failed (GoCardless 401). Проверь GOCARDLESS_SECRET_ID / GOCARDLESS_SECRET_KEY и активность аккаунта.',
                error: msg
            });
            return;
        }
        res.status(500).json({ message: 'Failed to fetch institutions', error: msg });
    }
});
router.post('/start', auth_1.authenticateToken, async (req, res) => {
    try {
        const user = req.user;
        const { institutionId, country, useAgreement, max_historical_days, access_valid_for_days, access_scope, user_language, reference } = req.body || {};
        const chosenCountry = (country || DEFAULT_COUNTRY).toUpperCase();
        let instId = institutionId;
        if (!instId) {
            // Try to auto-pick Revolut for the country
            try {
                const institutions = await (0, gocardless_1.listInstitutions)(chosenCountry);
                const revolut = institutions.find((i) => (i.name || '').toLowerCase().includes('revolut') && (i.countries || []).includes(chosenCountry)) || institutions.find((i) => (i.name || '').toLowerCase().includes('revolut'));
                if (revolut) {
                    instId = revolut.id;
                }
                else {
                    // If sandbox, allow fallback to the special sandbox institution. In live — require explicit institutionId.
                    if (IS_SANDBOX) {
                        instId = SANDBOX_DEFAULT_INSTITUTION;
                    }
                    else {
                        res.status(400).json({
                            message: 'institutionId is required in live mode',
                            hint: 'Сначала вызови /api/bankdata/institutions?country=' + chosenCountry + ' и передай выбранный institutionId в /start.',
                        });
                        return;
                    }
                }
            }
            catch (e) {
                // If listing fails: in sandbox fallback, in live — require explicit id
                if (IS_SANDBOX) {
                    instId = SANDBOX_DEFAULT_INSTITUTION;
                }
                else {
                    res.status(400).json({ message: 'institutionId is required (live mode)', error: e instanceof Error ? e.message : String(e) });
                    return;
                }
            }
        }
        // Всегда создаём соглашение c дефолтными параметрами, если явно не передано иное
        // Это гарантирует доступ к транзакциям, деталям и балансам и снижает вероятность 403.
        let agreementId = undefined;
        const agreementPayload = {
            max_historical_days: max_historical_days ?? 90,
            access_valid_for_days: access_valid_for_days ?? 90,
            access_scope: access_scope ?? ['transactions', 'details', 'balances'],
        };
        const agreement = await (0, gocardless_1.createEndUserAgreement)(instId, agreementPayload);
        agreementId = agreement.id;
        // Создаём requisition, при конфликте reference (дубликат) попробуем автоматически сгенерировать новый и повторить 1 раз
        let finalReference = reference;
        let requisition;
        try {
            requisition = await (0, gocardless_1.createRequisition)({
                redirect: REDIRECT_URL,
                institution_id: instId,
                reference: finalReference, // ?ref=<reference>
                agreement: agreementId,
                user_language: user_language || (chosenCountry === 'CZ' ? 'cs' : undefined),
            });
        }
        catch (e) {
            const msg = e?.message ? String(e.message) : String(e);
            const isDupRef = /reference/i.test(msg) && /(already|exists|duplicate)/i.test(msg);
            if (isDupRef) {
                finalReference = `${finalReference || 'ref'}_${Date.now()}`;
                console.warn('[bankdata/start] duplicate reference, retrying with', finalReference);
                requisition = await (0, gocardless_1.createRequisition)({
                    redirect: REDIRECT_URL,
                    institution_id: instId,
                    reference: finalReference,
                    agreement: agreementId,
                    user_language: user_language || (chosenCountry === 'CZ' ? 'cs' : undefined),
                });
            }
            else {
                throw e;
            }
        }
        const db = (0, database_1.getDB)();
        await db.collection('bank_requisitions').insertOne({
            userId: new mongodb_1.ObjectId(user.id),
            requisitionId: requisition.id,
            institutionId: instId,
            status: requisition.status,
            link: requisition.link,
            reference: finalReference || null,
            createdAt: new Date(),
        });
        res.json({ link: requisition.link, requisitionId: requisition.id, institutionId: instId, reference: finalReference });
    }
    catch (error) {
        console.error('bankdata/start error:', error instanceof Error ? error.stack : error);
        const msg = error instanceof Error ? error.message : String(error);
        // Попробуем дать небольшую подсказку по типичным причинам
        let hint;
        if (/reference/i.test(msg) && /already|exists|duplicate/i.test(msg)) {
            hint = 'Похоже reference уже использован. Попробуй уникальный reference (например ref_' + Date.now() + ').';
        }
        else if (/401/.test(msg)) {
            hint = 'Проблема авторизации к GoCardless (проверь секреты).';
        }
        else if (/403/.test(msg)) {
            hint = 'Доступ запрещён — проверь статус приложения или прав пользователя в GoCardless.';
        }
        res.status(500).json({ message: 'Failed to start bank linking', error: msg, hint });
    }
});
router.get('/callback', async (req, res) => {
    try {
        // По факту провайдер возвращает ?ref=<reference>, а не requisitionId.
        let refParam = req.query.ref || req.query.requisition || req.query.id;
        if (!refParam) {
            res.status(400).json({ message: 'Missing ref' });
            return;
        }
        const db = (0, database_1.getDB)();
        let requisitionId = refParam;
        // Эвристика: requisitionId обычно UUID с дефисами. Если нет дефисов или короткая строка — это reference.
        const looksLikeUuid = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i.test(refParam);
        if (!looksLikeUuid) {
            const rec = await db.collection('bank_requisitions').findOne({ reference: refParam });
            if (!rec) {
                res.status(404).json({ message: 'Unknown reference (no requisition found)' });
                return;
            }
            requisitionId = rec.requisitionId;
        }
        const info = await (0, gocardless_1.getRequisition)(requisitionId);
        await db.collection('bank_requisitions').updateOne({ requisitionId }, { $set: { status: info.status, accounts: info.accounts || [], updatedAt: new Date() } }, { upsert: true });
        const clientUrl = process.env.CLIENT_URL || 'http://localhost:3000';
        res.redirect(`${clientUrl}/bank?bank_linked=1`);
    }
    catch (error) {
        console.error('bankdata/callback error:', error);
        res.status(500).json({ message: 'Callback processing failed' });
    }
});
router.get('/accounts', auth_1.authenticateToken, async (req, res) => {
    try {
        const user = req.user;
        const db = (0, database_1.getDB)();
        const reqs = await db.collection('bank_requisitions').find({ userId: new mongodb_1.ObjectId(user.id) }).toArray();
        const accounts = [];
        for (const r of reqs) {
            try {
                const info = await (0, gocardless_1.getRequisition)(r.requisitionId);
                if (Array.isArray(info.accounts))
                    accounts.push(...info.accounts);
            }
            catch (e) { }
        }
        const uniq = Array.from(new Set(accounts));
        // Upsert into bank_accounts collection (track seen accounts for auto-sync)
        try {
            const db = (0, database_1.getDB)();
            const acctCol = db.collection('bank_accounts');
            for (const a of uniq) {
                await acctCol.updateOne({ userId: new mongodb_1.ObjectId(user.id), accountId: a }, { $setOnInsert: { createdAt: new Date() } }, { upsert: true });
            }
        }
        catch { }
        res.json({ accounts: uniq });
    }
    catch (error) {
        console.error('bankdata/accounts error:', error);
        res.status(500).json({ message: 'Failed to list accounts' });
    }
});
router.get('/transactions', auth_1.authenticateToken, async (req, res) => {
    try {
        const { accountId, date_from, date_to } = req.query;
        if (!accountId) {
            res.status(400).json({ message: 'accountId is required' });
            return;
        }
        const tx = await (0, gocardless_1.getAccountTransactions)(accountId, { date_from, date_to });
        res.json(tx);
    }
    catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        console.error('bankdata/transactions error:', msg);
        // Пробросим полезные детали наверх, но без чувствительных данных
        const isUpstreamAuth = /GoCardless API error 401/i.test(msg);
        const isUpstream400 = /GoCardless API error 400/i.test(msg);
        const isUpstream403 = /GoCardless API error 403/i.test(msg);
        const isUpstream404 = /GoCardless API error 404/i.test(msg);
        const status = isUpstreamAuth ? 502 : isUpstream400 ? 400 : isUpstream403 ? 502 : isUpstream404 ? 404 : 500;
        const hint = isUpstreamAuth
            ? 'Upstream 401 from GoCardless. Проверь валидность токена/секретов и статус согласия.'
            : isUpstream400
                ? 'Upstream 400: проверь корректность параметров (accountId, date_from, date_to). Даты должны быть в формате YYYY-MM-DD и не выходить за допустимый интервал провайдера.'
                : isUpstream403
                    ? 'Upstream 403: доступ запрещён. Возможно истёк срок действия согласия или нет прав на транзакции.'
                    : isUpstream404
                        ? 'Upstream 404: аккаунт не найден или недоступен для данного requisition.'
                        : undefined;
        res.status(status).json({ message: 'Failed to fetch transactions', error: msg, params: req.query, hint });
    }
});
router.post('/import', auth_1.authenticateToken, async (req, res) => {
    try {
        const user = req.user;
        const { accountId, date_from, date_to, incremental, mode } = req.body || {};
        if (!accountId) {
            res.status(400).json({ message: 'accountId is required' });
            return;
        }
        if (!canCallAccount(accountId)) {
            res.status(429).json({ message: 'Local soft limit reached', softLimit: DAILY_SOFT_LIMIT, hint: 'Жди окно или увеличь BANKDATA_SOFT_LIMIT' });
            return;
        }
        let finalFrom = date_from;
        let finalTo = date_to;
        // Incremental mode (default true) if no explicit range passed
        if (!date_from && !date_to && incremental !== false) {
            try {
                const db = (0, database_1.getDB)();
                const txCol = db.collection('transaction');
                // find latest bank transaction for this user/account by date then time
                const latest = await txCol.find({
                    userId: new mongodb_1.ObjectId(user.id),
                    source: 'bank',
                    bankAccountId: accountId
                }).sort({ date: -1, time: -1 }).limit(1).toArray();
                if (latest.length) {
                    // add one day to avoid re-fetch duplicates
                    const d = new Date(latest[0].date + 'T00:00:00Z');
                    d.setUTCDate(d.getUTCDate() + 1);
                    const iso = d.toISOString().slice(0, 10);
                    finalFrom = iso;
                }
            }
            catch (e) {
                console.warn('[bankdata/import] incremental probe failed:', e.message);
            }
        }
        let data;
        try {
            noteCall(accountId);
            data = await (0, gocardless_1.getAccountTransactions)(accountId, { date_from: finalFrom, date_to: finalTo });
        }
        catch (e) {
            if (/429/.test(String(e?.message)))
                note429(accountId);
            throw e;
        }
        const db = (0, database_1.getDB)();
        const acctCol = db.collection('bank_accounts');
        if (mode === 'async') {
            const job = await (0, bankImport_1.startAsyncImport)(user.id, accountId, data);
            await acctCol.updateOne({ userId: new mongodb_1.ObjectId(user.id), accountId }, { $set: { lastSyncStartedAt: new Date() } }, { upsert: true });
            res.json({ message: 'Import started', jobId: job.jobId, total: job.total, phase: job.phase, usedRange: { date_from: finalFrom, date_to: finalTo }, incremental: incremental !== false, async: true });
        }
        else {
            const result = await (0, bankImport_1.importAccountTransactions)(user.id, accountId, data);
            await acctCol.updateOne({ userId: new mongodb_1.ObjectId(user.id), accountId }, { $set: { lastSync: new Date(), lastSyncImported: result.imported, lastSyncDuplicates: result.duplicatesCount } }, { upsert: true });
            res.json({ message: 'Imported', ...result, usedRange: { date_from: finalFrom, date_to: finalTo }, incremental: incremental !== false });
        }
    }
    catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        console.error('bankdata/import error:', msg);
        const isUpstream429 = /GoCardless API error 429/i.test(msg);
        const retrySecondsMatch = msg.match(/rate limit.*?(\d+)\s*seconds?/i);
        const retryAfter = retrySecondsMatch ? Number(retrySecondsMatch[1]) : undefined;
        const isUpstreamAuth = /GoCardless API error 401/i.test(msg);
        const isUpstream400 = /GoCardless API error 400/i.test(msg);
        const isUpstream403 = /GoCardless API error 403/i.test(msg);
        const isUpstream404 = /GoCardless API error 404/i.test(msg);
        const status = isUpstream429 ? 429 : isUpstreamAuth ? 502 : isUpstream400 ? 400 : isUpstream403 ? 502 : isUpstream404 ? 404 : 500;
        const payload = {
            message: isUpstream429
                ? "You’ve used all available bank synchronizations for today. Try again tomorrow."
                : 'Failed to import transactions',
            error: msg,
            body: req.body
        };
        if (isUpstream429) {
            payload.hint = 'GoCardless per-resource daily rate limit reached.';
            if (retryAfter)
                payload.retryAfterSeconds = retryAfter;
        }
        res.status(status).json(payload);
    }
});
// Explicit async start endpoint (alias to /import with mode=async)
router.post('/import/start', auth_1.authenticateToken, async (req, res) => {
    req.body = { ...(req.body || {}), mode: 'async' };
    // delegate to /import handler logic
    return router.handle(req, res, () => { }); // naive delegation (Express internal) - simple reuse
});
// Progress polling endpoint
router.get('/import/progress/:jobId', auth_1.authenticateToken, (req, res) => {
    try {
        const jobId = req.params.jobId;
        const job = (0, bankImport_1.getImportJob)(jobId);
        if (!job) {
            res.status(404).json({ message: 'Unknown job' });
            return;
        }
        // Basic ETA estimation
        let etaMs = null;
        if (job.processed > 5 && job.total > job.processed) {
            const elapsed = Date.now() - job.startedAt;
            const per = elapsed / job.processed;
            etaMs = Math.round(per * (job.total - job.processed));
        }
        res.json({
            jobId: job.jobId,
            total: job.total,
            processed: job.processed,
            imported: job.imported,
            duplicatesCount: job.duplicatesCount,
            phase: job.phase,
            startedAt: job.startedAt,
            updatedAt: job.updatedAt,
            done: job.done,
            error: job.error || null,
            etaMs
        });
    }
    catch (e) {
        res.status(500).json({ message: 'Progress error', error: e?.message || String(e) });
    }
});
// On-demand auto import trigger: checks lastSync age and starts async if stale
router.post('/auto/sync', auth_1.authenticateToken, async (req, res) => {
    try {
        const user = req.user;
        const { minAgeMinutes } = req.body || {};
        const minAge = typeof minAgeMinutes === 'number' ? minAgeMinutes : AUTO_ON_DEMAND_MIN_AGE_MIN;
        const db = (0, database_1.getDB)();
        const acctCol = db.collection('bank_accounts');
        const now = Date.now();
        const staleTs = new Date(now - minAge * 60 * 1000);
        const staleAccounts = await acctCol.find({ userId: new mongodb_1.ObjectId(user.id), $or: [{ lastSync: { $lt: staleTs } }, { lastSync: { $exists: false } }] }).limit(5).toArray();
        const started = [];
        for (const a of staleAccounts) {
            try {
                if (!canCallAccount(a.accountId))
                    continue; // daily cap (default 4)
                noteCall(a.accountId);
                const data = await (0, gocardless_1.getAccountTransactions)(a.accountId, {});
                const job = await (0, bankImport_1.startAsyncImport)(user.id, a.accountId, data);
                started.push({ accountId: a.accountId, jobId: job.jobId, total: job.total });
                await acctCol.updateOne({ _id: a._id }, { $set: { lastSyncQueuedAt: new Date() } });
            }
            catch (e) { /* ignore per-account */ }
        }
        res.json({ started, count: started.length });
    }
    catch (e) {
        res.status(500).json({ message: 'Auto sync error', error: e?.message || String(e) });
    }
});
// Debug import from static JSON file (Revolut sample). Not for production use.
router.post('/import/debug', auth_1.authenticateToken, async (req, res) => {
    try {
        if (process.env.NODE_ENV === 'production') {
            res.status(403).json({ message: 'Disabled in production' });
            return;
        }
        const user = req.user;
        const { accountId } = req.body || {};
        const debugFile = process.env.BANKDATA_DEBUG_FILE || node_path_1.default.join(__dirname, '../../..', 'Client', 'public', 'data', 'transaction-revoult-debug.json');
        if (!node_fs_1.default.existsSync(debugFile)) {
            res.status(404).json({ message: 'Debug file not found', debugFile });
            return;
        }
        const raw = await node_fs_1.default.promises.readFile(debugFile, 'utf8');
        let parsed;
        try {
            parsed = JSON.parse(raw);
        }
        catch (e) {
            res.status(500).json({ message: 'Invalid JSON in debug file', error: e.message });
            return;
        }
        const acct = accountId || 'debug-revolut';
        const result = await (0, bankImport_1.importAccountTransactions)(user.id, acct, parsed);
        res.json({ message: 'Imported (debug)', ...result, debugFile, accountId: acct });
    }
    catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        res.status(500).json({ message: 'Failed debug import', error: msg });
    }
});
// Account helpers
router.get('/account/details', auth_1.authenticateToken, async (req, res) => {
    try {
        const { accountId } = req.query;
        if (!accountId) {
            res.status(400).json({ message: 'accountId is required' });
            return;
        }
        const details = await (0, gocardless_1.getAccountDetails)(accountId);
        res.json(details);
    }
    catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        console.error('bankdata/account/details error:', msg);
        res.status(/404/.test(msg) ? 404 : 500).json({ message: 'Failed to fetch account details', error: msg });
    }
});
router.get('/account/balances', auth_1.authenticateToken, async (req, res) => {
    try {
        const { accountId } = req.query;
        if (!accountId) {
            res.status(400).json({ message: 'accountId is required' });
            return;
        }
        const balances = await (0, gocardless_1.getAccountBalances)(accountId);
        res.json(balances);
    }
    catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        console.error('bankdata/account/balances error:', msg);
        res.status(/404/.test(msg) ? 404 : 500).json({ message: 'Failed to fetch account balances', error: msg });
    }
});
// --- Webhook endpoint ---
// Receives GoCardless Bank Account Data webhooks.
// We verify using a shared secret passed in a header. Since header naming varies by providers,
// we accept a few common variants. Adjust once you confirm the exact header from GC.
// NOTE: Bank Account Data не предоставляет вебхуки (по ответу поддержки).
// Маршрут вебхука отключен. Оставлено как комментарий для истории.
// router.post('/webhook', async (req: Request, res: Response): Promise<void> => { /* disabled */ });
exports.default = router;
