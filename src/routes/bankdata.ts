import { Router, Request, Response } from 'express';
import { authenticateToken } from '../middleware/auth';
import { 
  listInstitutions,
  createEndUserAgreement,
  createRequisition,
  getRequisition,
  getAccountTransactions,
  getAccountDetails,
  getAccountBalances,
  __gocardlessDebug,
  debugObtainTokenMeta
} from '../api/gocardless';
import dns from 'node:dns';
import { request as httpsRequest } from 'node:https';
import { getDB } from '../middleware/database';
import { ObjectId } from 'mongodb';
import { importAccountTransactions, startAsyncImport, getImportJob } from '../api/bankImport';
import fs from 'node:fs';
import path from 'node:path';
const router = Router();

// In-memory per-account soft throttle to avoid exceeding upstream daily limits (resets daily)
const accountCallStats = new Map<string, { day: string; calls: number; last429?: number }>();
const DAILY_SOFT_LIMIT = Number(process.env.BANKDATA_SOFT_LIMIT || 4);
function _statFor(accountId: string) {
  const today = new Date().toISOString().slice(0,10);
  let s = accountCallStats.get(accountId);
  if (!s || s.day !== today) { s = { day: today, calls: 0 }; accountCallStats.set(accountId, s); }
  return s;
}
function canCallAccount(accountId: string) {
  const s = _statFor(accountId);
  return s.calls < DAILY_SOFT_LIMIT;
}
function noteCall(accountId: string) { const s = _statFor(accountId); s.calls++; }
function note429(accountId: string) { const s = _statFor(accountId); s.last429 = Date.now(); }

const DEFAULT_COUNTRY = (process.env.BANKDATA_DEFAULT_COUNTRY || 'cz').toUpperCase();
const SANDBOX_DEFAULT_INSTITUTION = process.env.BANKDATA_SANDBOX_INSTITUTION || 'SANDBOXFINANCE_SFIN0000';
const REDIRECT_URL = process.env.BANKDATA_REDIRECT_URL || 'http://localhost:3001/api/bankdata/callback';
const IS_SANDBOX = (process.env.GOCARDLESS_SECRET_KEY || '').startsWith('sandbox_');
// Auto-sync configuration
const AUTO_ON_DEMAND_MIN_AGE_MIN = Number(process.env.BANKDATA_AUTO_ON_DEMAND_MIN_AGE_MIN || 20); // trigger if older than 20 min
const AUTO_MORNING_HOUR = Number(process.env.BANKDATA_AUTO_MORNING_HOUR || 6); // 6 AM server time
let lastMorningRunDay: string | null = null;

// Periodic lightweight scheduler (runs every 5 minutes) to perform morning catch-up sync
setInterval(async () => {
  try {
    const now = new Date();
    const day = now.toISOString().slice(0,10);
    if (now.getHours() === AUTO_MORNING_HOUR && lastMorningRunDay !== day) {
      const db = getDB();
      const acctCol = db.collection('bank_accounts');
      const threshold = Date.now() - 1000 * 60 * 60 * 12; // 12h
      const stale = await acctCol.find({ lastSync: { $lt: new Date(threshold) } }).limit(50).toArray();
    for (const s of stale) {
        // Fire async import if possible (ignore errors)
        try {
          const userId = s.userId?.toString();
          if (!userId) continue;
      if (!canCallAccount(s.accountId)) continue; // respect daily cap
      noteCall(s.accountId);
          const data = await getAccountTransactions(s.accountId, {} as any);
          await startAsyncImport(userId, s.accountId, data);
          await acctCol.updateOne({ _id: s._id }, { $set: { lastSyncQueuedAt: new Date() } });
        } catch (e) { /* ignore */ }
      }
      lastMorningRunDay = day;
    }
  } catch (e) { /* silent */ }
}, 1000 * 60 * 5);

router.get('/_ping', (req: Request, res: Response) => {
  res.json({ ok: true, route: 'bankdata' });
});

// Debug: current per-account call counters (auth required to avoid leaking IDs).
router.get('/debug/account-calls', authenticateToken, (_req: Request, res: Response) => {
  try {
    const entries: any[] = [];
    for (const [accountId, stat] of accountCallStats.entries()) {
      entries.push({ accountId, day: stat.day, calls: stat.calls, last429: stat.last429 || null, remaining: Math.max(0, DAILY_SOFT_LIMIT - stat.calls) });
    }
    res.json({ softLimit: DAILY_SOFT_LIMIT, accounts: entries });
  } catch (e: any) {
    res.status(500).json({ message: 'Failed to read counters', error: e?.message || String(e) });
  }
});

// Simple echo route for low-level diagnostics (no auth)
router.get('/_echo', (req: Request, res: Response) => {
  console.log('[ECHO HIT] headers:', Object.keys(req.headers));
  res.json({ ok: true, echo: true, ts: Date.now() });
});

// Quick env debug: shows mode and key config (no secrets)
router.get('/debug/env', (_req: Request, res: Response) => {
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
router.get('/debug/institutions', async (req: Request, res: Response) => {
  try {
  const country = ((req.query.country as string) || DEFAULT_COUNTRY).toUpperCase();
    const list = await listInstitutions(country);
    const q = (req.query.q as string)?.toLowerCase().trim();
    const all = req.query.all === '1' || req.query.all === 'true';
    const limit = Math.min(Number(req.query.limit) || 20, 500);
    const filtered = q
      ? (list || []).filter((i: any) => (i.name || '').toLowerCase().includes(q) || (i.id || '').toLowerCase().includes(q))
      : list || [];
    const payload = all ? filtered : filtered.slice(0, limit);
    res.json({ ok: true, country, count: Array.isArray(list) ? list.length : 0, returned: payload.length, items: payload });
  } catch (e: any) {
    res.status(500).json({ ok: false, error: e?.message || String(e) });
  }
});

// Debug token cache
router.get('/debug/token', (_req: Request, res: Response) => {
  try {
    res.json({ ok: true, token: __gocardlessDebug.tokenState() });
  } catch (e: any) {
    res.status(500).json({ ok: false, error: e?.message || String(e) });
  }
});

router.post('/debug/newtoken', async (_req: Request, res: Response) => {
  try {
    const meta = await debugObtainTokenMeta();
    res.json({ ok: true, meta });
  } catch (e: any) {
    res.status(500).json({ ok: false, error: e?.message || String(e) });
  }
});

// Simple network ping (DNS + HEAD) to GoCardless host
router.get('/debug/net', async (_req: Request, res: Response) => {
  const host = 'bankaccountdata.gocardless.com';
  const started = Date.now();
  dns.lookup(host, (err, address) => {
    const dnsMs = Date.now() - started;
    if (err) return res.status(500).json({ ok: false, stage: 'dns', error: err.message });
    const req = httpsRequest({ host, path: '/api/v2/status/', method: 'GET', timeout: 5000 }, (r) => {
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
router.get('/debug/requisitions', authenticateToken, async (req: Request, res: Response) => {
  try {
    const user = (req as any).user;
    const db = getDB();
    const list = await db.collection('bank_requisitions')
      .find({ userId: new ObjectId(user.id) })
      .project({ _id: 0 })
      .sort({ createdAt: -1 })
      .toArray();
    res.json({ ok: true, count: list.length, requisitions: list });
  } catch (e: any) {
    res.status(500).json({ ok: false, error: e?.message || String(e) });
  }
});

router.get('/institutions', authenticateToken, async (req: Request, res: Response) => {
  try {
    const country = ((req.query.country as string) || DEFAULT_COUNTRY).toUpperCase();
    const institutions = await listInstitutions(country);
    res.json({ institutions });
  } catch (error) {
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

router.post('/start', authenticateToken, async (req: Request, res: Response) => {
  try {
    const user = (req as any).user;
  const { institutionId, country, useAgreement, max_historical_days, access_valid_for_days, access_scope, user_language, reference } = req.body || {};

    const chosenCountry = (country || DEFAULT_COUNTRY).toUpperCase();

    let instId = institutionId as string | undefined;
    if (!instId) {
      // Try to auto-pick Revolut for the country
      try {
        const institutions = await listInstitutions(chosenCountry);
        const revolut = institutions.find((i: any) =>
          (i.name || '').toLowerCase().includes('revolut') && (i.countries || []).includes(chosenCountry)
        ) || institutions.find((i: any) => (i.name || '').toLowerCase().includes('revolut'));
        if (revolut) {
          instId = revolut.id;
        } else {
          // If sandbox, allow fallback to the special sandbox institution. In live — require explicit institutionId.
          if (IS_SANDBOX) {
            instId = SANDBOX_DEFAULT_INSTITUTION;
          } else {
            res.status(400).json({
              message: 'institutionId is required in live mode',
              hint: 'Сначала вызови /api/bankdata/institutions?country='+chosenCountry+' и передай выбранный institutionId в /start.',
            });
            return;
          }
        }
      } catch (e) {
        // If listing fails: in sandbox fallback, in live — require explicit id
        if (IS_SANDBOX) {
          instId = SANDBOX_DEFAULT_INSTITUTION;
        } else {
          res.status(400).json({ message: 'institutionId is required (live mode)', error: e instanceof Error ? e.message : String(e) });
          return;
        }
      }
    }

    // Всегда создаём соглашение c дефолтными параметрами, если явно не передано иное
    // Это гарантирует доступ к транзакциям, деталям и балансам и снижает вероятность 403.
  let agreementId: string | undefined = undefined;
    const agreementPayload = {
      max_historical_days: max_historical_days ?? 90,
      access_valid_for_days: access_valid_for_days ?? 90,
      access_scope: access_scope ?? (['transactions', 'details', 'balances'] as any),
    };
    const agreement = await createEndUserAgreement(instId!, agreementPayload);
    agreementId = agreement.id;

    // Создаём requisition, при конфликте reference (дубликат) попробуем автоматически сгенерировать новый и повторить 1 раз
    let finalReference = reference as string | undefined;
    let requisition: any;
    try {
      requisition = await createRequisition({
        redirect: REDIRECT_URL,
        institution_id: instId!,
        reference: finalReference, // ?ref=<reference>
        agreement: agreementId,
        user_language: user_language || (chosenCountry === 'CZ' ? 'cs' : undefined),
      });
    } catch (e: any) {
      const msg = e?.message ? String(e.message) : String(e);
      const isDupRef = /reference/i.test(msg) && /(already|exists|duplicate)/i.test(msg);
      if (isDupRef) {
        finalReference = `${finalReference || 'ref'}_${Date.now()}`;
        console.warn('[bankdata/start] duplicate reference, retrying with', finalReference);
        requisition = await createRequisition({
          redirect: REDIRECT_URL,
          institution_id: instId!,
          reference: finalReference,
          agreement: agreementId,
          user_language: user_language || (chosenCountry === 'CZ' ? 'cs' : undefined),
        });
      } else {
        throw e;
      }
    }

    const db = getDB();
    await db.collection('bank_requisitions').insertOne({
      userId: new ObjectId(user.id),
      requisitionId: requisition.id,
      institutionId: instId,
      status: requisition.status,
      link: requisition.link,
      reference: finalReference || null,
      createdAt: new Date(),
    });

    res.json({ link: requisition.link, requisitionId: requisition.id, institutionId: instId, reference: finalReference });
  } catch (error) {
    console.error('bankdata/start error:', error instanceof Error ? error.stack : error);
    const msg = error instanceof Error ? error.message : String(error);
    // Попробуем дать небольшую подсказку по типичным причинам
    let hint: string | undefined;
    if (/reference/i.test(msg) && /already|exists|duplicate/i.test(msg)) {
      hint = 'Похоже reference уже использован. Попробуй уникальный reference (например ref_'+Date.now()+').';
    } else if (/401/.test(msg)) {
      hint = 'Проблема авторизации к GoCardless (проверь секреты).';
    } else if (/403/.test(msg)) {
      hint = 'Доступ запрещён — проверь статус приложения или прав пользователя в GoCardless.';
    }
    res.status(500).json({ message: 'Failed to start bank linking', error: msg, hint });
  }
});

router.get('/callback', async (req: Request, res: Response) => {
  try {
    // По факту провайдер возвращает ?ref=<reference>, а не requisitionId.
    let refParam = (req.query.ref as string) || (req.query.requisition as string) || (req.query.id as string);
    if (!refParam) {
      res.status(400).json({ message: 'Missing ref' });
      return;
    }

    const db = getDB();
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

    const info = await getRequisition(requisitionId);

    await db.collection('bank_requisitions').updateOne(
      { requisitionId },
      { $set: { status: info.status, accounts: info.accounts || [], updatedAt: new Date() } },
      { upsert: true }
    );

    const clientUrl = process.env.CLIENT_URL || 'http://localhost:3000';
    res.redirect(`${clientUrl}/bank?bank_linked=1`);
  } catch (error) {
    console.error('bankdata/callback error:', error);
    res.status(500).json({ message: 'Callback processing failed' });
  }
});

router.get('/accounts', authenticateToken, async (req: Request, res: Response) => {
  try {
    const user = (req as any).user;
    const db = getDB();
    const reqs = await db.collection('bank_requisitions').find({ userId: new ObjectId(user.id) }).toArray();

    const accounts: string[] = [];
    for (const r of reqs) {
      try {
        const info = await getRequisition(r.requisitionId);
        if (Array.isArray(info.accounts)) accounts.push(...info.accounts);
      } catch (e) {}
    }

    const uniq = Array.from(new Set(accounts));
    // Upsert into bank_accounts collection (track seen accounts for auto-sync)
    try {
      const db = getDB();
      const acctCol = db.collection('bank_accounts');
      for (const a of uniq) {
        await acctCol.updateOne({ userId: new ObjectId(user.id), accountId: a }, { $setOnInsert: { createdAt: new Date() } }, { upsert: true });
      }
    } catch {}
    res.json({ accounts: uniq });
  } catch (error) {
    console.error('bankdata/accounts error:', error);
    res.status(500).json({ message: 'Failed to list accounts' });
  }
});

router.get('/transactions', authenticateToken, async (req: Request, res: Response) => {
  try {
    const { accountId, date_from, date_to } = req.query as { accountId?: string; date_from?: string; date_to?: string };
    if (!accountId) {
      res.status(400).json({ message: 'accountId is required' });
      return;
    }

    const tx = await getAccountTransactions(accountId, { date_from, date_to });
    res.json(tx);
  } catch (error) {
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

router.post('/import', authenticateToken, async (req: Request, res: Response) => {
  try {
    const user = (req as any).user;
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
        const db = getDB();
        const txCol = db.collection('transaction');
        // find latest bank transaction for this user/account by date then time
        const latest = await txCol.find({
          userId: new ObjectId(user.id),
          source: 'bank',
          bankAccountId: accountId
        }).sort({ date: -1, time: -1 }).limit(1).toArray();
        if (latest.length) {
          // add one day to avoid re-fetch duplicates
          const d = new Date(latest[0].date + 'T00:00:00Z');
          d.setUTCDate(d.getUTCDate() + 1);
          const iso = d.toISOString().slice(0,10);
          finalFrom = iso;
        }
      } catch (e) {
        console.warn('[bankdata/import] incremental probe failed:', (e as Error).message);
      }
    }

    let data;
    try {
      noteCall(accountId);
      data = await getAccountTransactions(accountId, { date_from: finalFrom, date_to: finalTo });
    } catch (e: any) {
      if (/429/.test(String(e?.message))) note429(accountId);
      throw e;
    }
    const db = getDB();
    const acctCol = db.collection('bank_accounts');
    if (mode === 'async') {
      const job = await startAsyncImport(user.id, accountId, data);
      await acctCol.updateOne({ userId: new ObjectId(user.id), accountId }, { $set: { lastSyncStartedAt: new Date() } }, { upsert: true });
      res.json({ message: 'Import started', jobId: job.jobId, total: job.total, phase: job.phase, usedRange: { date_from: finalFrom, date_to: finalTo }, incremental: incremental !== false, async: true });
    } else {
      const result = await importAccountTransactions(user.id, accountId, data);
      await acctCol.updateOne({ userId: new ObjectId(user.id), accountId }, { $set: { lastSync: new Date(), lastSyncImported: result.imported, lastSyncDuplicates: result.duplicatesCount } }, { upsert: true });
      res.json({ message: 'Imported', ...result, usedRange: { date_from: finalFrom, date_to: finalTo }, incremental: incremental !== false });
    }
  } catch (error) {
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
  const payload: any = {
    message: isUpstream429
      ? "You’ve used all available bank synchronizations for today. Try again tomorrow."
      : 'Failed to import transactions',
    error: msg,
    body: req.body
  };
  if (isUpstream429) {
    payload.hint = 'GoCardless per-resource daily rate limit reached.';
    if (retryAfter) payload.retryAfterSeconds = retryAfter;
  }
  res.status(status).json(payload);
  }
});

// Explicit async start endpoint (alias to /import with mode=async)
router.post('/import/start', authenticateToken, async (req: Request, res: Response) => {
  (req as any).body = { ...(req.body || {}), mode: 'async' };
  // delegate to /import handler logic
  return (router as any).handle(req, res, () => {}); // naive delegation (Express internal) - simple reuse
});

// Progress polling endpoint
router.get('/import/progress/:jobId', authenticateToken, (req: Request, res: Response) => {
  try {
    const jobId = req.params.jobId;
    const job = getImportJob(jobId);
    if (!job) {
      res.status(404).json({ message: 'Unknown job' });
      return;
    }
    // Basic ETA estimation
    let etaMs: number | null = null;
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
  } catch (e: any) {
    res.status(500).json({ message: 'Progress error', error: e?.message || String(e) });
  }
});

// On-demand auto import trigger: checks lastSync age and starts async if stale
router.post('/auto/sync', authenticateToken, async (req: Request, res: Response) => {
  try {
    const user = (req as any).user;
    const { minAgeMinutes } = req.body || {};
    const minAge = typeof minAgeMinutes === 'number' ? minAgeMinutes : AUTO_ON_DEMAND_MIN_AGE_MIN;
    const db = getDB();
    const acctCol = db.collection('bank_accounts');
    const now = Date.now();
    const staleTs = new Date(now - minAge * 60 * 1000);
    const staleAccounts = await acctCol.find({ userId: new ObjectId(user.id), $or: [ { lastSync: { $lt: staleTs } }, { lastSync: { $exists: false } } ] }).limit(5).toArray();
    const started: any[] = [];
  for (const a of staleAccounts) {
      try {
    if (!canCallAccount(a.accountId)) continue; // daily cap (default 4)
    noteCall(a.accountId);
    const data = await getAccountTransactions(a.accountId, {} as any);
        const job = await startAsyncImport(user.id, a.accountId, data);
        started.push({ accountId: a.accountId, jobId: job.jobId, total: job.total });
        await acctCol.updateOne({ _id: a._id }, { $set: { lastSyncQueuedAt: new Date() } });
      } catch (e) { /* ignore per-account */ }
    }
    res.json({ started, count: started.length });
  } catch (e: any) {
    res.status(500).json({ message: 'Auto sync error', error: e?.message || String(e) });
  }
});

// Debug import from static JSON file (Revolut sample). Not for production use.
router.post('/import/debug', authenticateToken, async (req: Request, res: Response) => {
  try {
    if (process.env.NODE_ENV === 'production') {
      res.status(403).json({ message: 'Disabled in production' });
      return;
    }
    const user = (req as any).user;
    const { accountId } = req.body || {};
    const debugFile = process.env.BANKDATA_DEBUG_FILE || path.join(__dirname, '../../..', 'Client', 'public', 'data', 'transaction-revoult-debug.json');
    if (!fs.existsSync(debugFile)) {
      res.status(404).json({ message: 'Debug file not found', debugFile });
      return;
    }
    const raw = await fs.promises.readFile(debugFile, 'utf8');
    let parsed: any;
    try { parsed = JSON.parse(raw); } catch (e) {
      res.status(500).json({ message: 'Invalid JSON in debug file', error: (e as Error).message });
      return;
    }
    const acct = accountId || 'debug-revolut';
    const result = await importAccountTransactions(user.id, acct, parsed);
    res.json({ message: 'Imported (debug)', ...result, debugFile, accountId: acct });
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    res.status(500).json({ message: 'Failed debug import', error: msg });
  }
});

// Account helpers
router.get('/account/details', authenticateToken, async (req: Request, res: Response) => {
  try {
    const { accountId } = req.query as { accountId?: string };
    if (!accountId) {
      res.status(400).json({ message: 'accountId is required' });
      return;
    }
    const details = await getAccountDetails(accountId);
    res.json(details);
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    console.error('bankdata/account/details error:', msg);
    res.status(/404/.test(msg) ? 404 : 500).json({ message: 'Failed to fetch account details', error: msg });
  }
});

router.get('/account/balances', authenticateToken, async (req: Request, res: Response) => {
  try {
    const { accountId } = req.query as { accountId?: string };
    if (!accountId) {
      res.status(400).json({ message: 'accountId is required' });
      return;
    }
    const balances = await getAccountBalances(accountId);
    res.json(balances);
  } catch (error) {
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

export default router;
