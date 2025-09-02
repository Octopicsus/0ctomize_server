"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.__gocardlessDebug = void 0;
exports.debugObtainTokenMeta = debugObtainTokenMeta;
exports.listInstitutions = listInstitutions;
exports.createEndUserAgreement = createEndUserAgreement;
exports.createRequisition = createRequisition;
exports.getRequisition = getRequisition;
exports.getAccountDetails = getAccountDetails;
exports.getAccountBalances = getAccountBalances;
exports.getAccountTransactions = getAccountTransactions;
const BASE_URL = process.env.GOCARDLESS_BASE_URL || 'https://bankaccountdata.gocardless.com/api/v2';
const SECRET_ID = process.env.GOCARDLESS_SECRET_ID?.trim();
const SECRET_KEY = process.env.GOCARDLESS_SECRET_KEY?.trim();
const DEBUG = (process.env.BANKDATA_DEBUG || '').toLowerCase() === 'true';
if (!SECRET_ID || !SECRET_KEY) {
    console.warn('[GoCardless] SECRET_ID/SECRET_KEY are not set. Configure in .env');
}
else if (DEBUG) {
    console.log('[GoCardless][DEBUG] Using secrets (masked):', {
        secretId: SECRET_ID?.slice(0, 4) + '...' + SECRET_ID?.slice(-4),
        secretKey: SECRET_KEY?.startsWith('sandbox_') ? 'sandbox_' + '***' : '***'
    });
}
let accessToken = null;
let accessTokenExpiresAt = 0;
let refreshToken = null;
let refreshTokenExpiresAt = 0;
// For diagnostics (not exported publicly): allows debug route to inspect token cache without exposing secrets
function _debugTokenState() {
    return {
        hasAccess: !!accessToken,
        accessExpiresIn: accessTokenExpiresAt ? accessTokenExpiresAt - Math.floor(Date.now() / 1000) : 0,
        hasRefresh: !!refreshToken,
        refreshExpiresIn: refreshTokenExpiresAt ? refreshTokenExpiresAt - Math.floor(Date.now() / 1000) : 0,
        now: Math.floor(Date.now() / 1000)
    };
}
async function request(path, init, timeoutMs = 8000) {
    const url = `${BASE_URL}${path}`;
    const method = init?.method || 'GET';
    const started = Date.now();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    if (DEBUG)
        console.log('[GoCardless][REQ->]', method, url, { timeoutMs });
    try {
        const res = await fetch(url, { ...(init || {}), signal: controller.signal });
        const ms = Date.now() - started;
        if (!res.ok) {
            const text = await res.text().catch(() => '');
            if (DEBUG)
                console.error('[GoCardless][RES!]', res.status, method, url, ms + 'ms', 'body:', text?.slice(0, 500));
            throw new Error(`GoCardless API error ${res.status}: ${text}`);
        }
        if (DEBUG)
            console.log('[GoCardless][RES<-]', res.status, method, url, (Date.now() - started) + 'ms');
        return res.json();
    }
    catch (e) {
        if (e?.name === 'AbortError') {
            throw new Error(`GoCardless API timeout after ${timeoutMs}ms for ${method} ${url}`);
        }
        throw e;
    }
    finally {
        clearTimeout(timer);
    }
}
async function ensureAccessToken() {
    const now = Math.floor(Date.now() / 1000);
    if (accessToken && now < accessTokenExpiresAt - 30) {
        return accessToken;
    }
    if (DEBUG)
        console.log('[GoCardless][TOKEN] fetching new access token...');
    // Obtain new token bundle
    const body = JSON.stringify({ secret_id: SECRET_ID, secret_key: SECRET_KEY });
    const bundle = await request('/token/new/', {
        method: 'POST',
        headers: { 'accept': 'application/json', 'Content-Type': 'application/json' },
        body,
    });
    if (DEBUG)
        console.log('[GoCardless][TOKEN] received bundle (expiry seconds):', bundle.access_expires, bundle.refresh_expires);
    accessToken = bundle.access;
    accessTokenExpiresAt = now + (bundle.access_expires || 60 * 60);
    refreshToken = bundle.refresh;
    refreshTokenExpiresAt = now + (bundle.refresh_expires || 30 * 24 * 60 * 60);
    return accessToken;
}
// Force fresh token fetch (ignores cache) for debug purposes; returns metadata only
async function debugObtainTokenMeta() {
    // invalidate cache first
    accessToken = null;
    accessTokenExpiresAt = 0;
    const token = await ensureAccessToken();
    return {
        obtained: !!token,
        tokenPrefix: token?.slice(0, 8) || null,
        tokenLength: token?.length || 0,
        expiresAt: accessTokenExpiresAt,
        now: Math.floor(Date.now() / 1000),
        secondsToExpiry: accessTokenExpiresAt - Math.floor(Date.now() / 1000)
    };
}
async function listInstitutions(country) {
    const token = await ensureAccessToken();
    try {
        return await request(`/institutions/?country=${encodeURIComponent(country)}`, {
            headers: { 'accept': 'application/json', 'Authorization': `Bearer ${token}` },
        });
    }
    catch (e) {
        if (DEBUG)
            console.error('[GoCardless][institutions] country', country, 'error:', e?.message);
        throw e;
    }
}
// Internal debug helper export (only to be used by debug routes)
exports.__gocardlessDebug = { tokenState: _debugTokenState };
async function createEndUserAgreement(institutionId, opts) {
    const token = await ensureAccessToken();
    const body = JSON.stringify({ institution_id: institutionId, ...opts });
    return request('/agreements/enduser/', {
        method: 'POST',
        headers: { 'accept': 'application/json', 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
        body,
    });
}
async function createRequisition(params) {
    const token = await ensureAccessToken();
    const body = JSON.stringify(params);
    return request('/requisitions/', {
        method: 'POST',
        headers: { 'accept': 'application/json', 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
        body,
    });
}
async function getRequisition(requisitionId) {
    const token = await ensureAccessToken();
    return request(`/requisitions/${encodeURIComponent(requisitionId)}/`, {
        headers: { 'accept': 'application/json', 'Authorization': `Bearer ${token}` },
    });
}
async function getAccountDetails(accountId) {
    const token = await ensureAccessToken();
    return request(`/accounts/${encodeURIComponent(accountId)}/details/`, {
        headers: { 'accept': 'application/json', 'Authorization': `Bearer ${token}` },
    });
}
async function getAccountBalances(accountId) {
    const token = await ensureAccessToken();
    return request(`/accounts/${encodeURIComponent(accountId)}/balances/`, {
        headers: { 'accept': 'application/json', 'Authorization': `Bearer ${token}` },
    });
}
async function getAccountTransactions(accountId, params) {
    const token = await ensureAccessToken();
    const qs = new URLSearchParams();
    // If no explicit range provided, default to last N days (env or 90)
    let dateFrom = params?.date_from;
    let dateTo = params?.date_to;
    const spanDays = params?.fullHistoryDays || Number(process.env.BANKDATA_DEFAULT_DAYS || 90);
    if (!dateFrom && !dateTo) {
        const today = new Date();
        const past = new Date(Date.now() - (spanDays - 1) * 24 * 60 * 60 * 1000);
        const fmt = (d) => d.toISOString().slice(0, 10);
        dateFrom = fmt(past);
        dateTo = fmt(today);
    }
    if (dateFrom)
        qs.set('date_from', dateFrom);
    if (dateTo)
        qs.set('date_to', dateTo);
    const suffix = qs.toString() ? `?${qs.toString()}` : '';
    const url = `/accounts/${encodeURIComponent(accountId)}/transactions/${suffix}`;
    // Debug log for visibility (can be downgraded later)
    console.log('[getAccountTransactions] requesting', url);
    return request(url, {
        headers: { 'accept': 'application/json', 'Authorization': `Bearer ${token}` },
    });
}
