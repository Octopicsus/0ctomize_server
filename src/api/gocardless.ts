

const BASE_URL = process.env.GOCARDLESS_BASE_URL || 'https://bankaccountdata.gocardless.com/api/v2';
const SECRET_ID = process.env.GOCARDLESS_SECRET_ID?.trim();
const SECRET_KEY = process.env.GOCARDLESS_SECRET_KEY?.trim();
const DEBUG = (process.env.BANKDATA_DEBUG || '').toLowerCase() === 'true';

if (!SECRET_ID || !SECRET_KEY) {
  console.warn('[GoCardless] SECRET_ID/SECRET_KEY are not set. Configure in .env');
} else if (DEBUG) {
  console.log('[GoCardless][DEBUG] Using secrets (masked):',
    {
      secretId: SECRET_ID?.slice(0, 4) + '...' + SECRET_ID?.slice(-4),
      secretKey: SECRET_KEY?.startsWith('sandbox_') ? 'sandbox_' + '***' : '***'
    }
  );
}

type AccessTokenBundle = {
  access: string;
  access_expires: number; 
  refresh: string;
  refresh_expires: number; 
};

let accessToken: string | null = null;
let accessTokenExpiresAt = 0;
let refreshToken: string | null = null;
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

async function request<T>(path: string, init?: any, timeoutMs = 8000): Promise<T> {
  const url = `${BASE_URL}${path}`;
  const method = init?.method || 'GET';
  const started = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  if (DEBUG) console.log('[GoCardless][REQ->]', method, url, { timeoutMs });
  try {
    const res = await fetch(url, { ...(init || {}), signal: controller.signal } as any);
    const ms = Date.now() - started;
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      if (DEBUG) console.error('[GoCardless][RES!]', res.status, method, url, ms + 'ms', 'body:', text?.slice(0, 500));
      throw new Error(`GoCardless API error ${res.status}: ${text}`);
    }
    if (DEBUG) console.log('[GoCardless][RES<-]', res.status, method, url, (Date.now() - started) + 'ms');
    return res.json() as Promise<T>;
  } catch (e: any) {
    if (e?.name === 'AbortError') {
      throw new Error(`GoCardless API timeout after ${timeoutMs}ms for ${method} ${url}`);
    }
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

async function ensureAccessToken(): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  if (accessToken && now < accessTokenExpiresAt - 30) {
    return accessToken;
  }
  if (DEBUG) console.log('[GoCardless][TOKEN] fetching new access token...');

  // Obtain new token bundle
  const body = JSON.stringify({ secret_id: SECRET_ID, secret_key: SECRET_KEY });
  const bundle = await request<AccessTokenBundle>('/token/new/', {
    method: 'POST',
    headers: { 'accept': 'application/json', 'Content-Type': 'application/json' },
    body,
  });
  if (DEBUG) console.log('[GoCardless][TOKEN] received bundle (expiry seconds):', bundle.access_expires, bundle.refresh_expires);

  accessToken = bundle.access;
  accessTokenExpiresAt = now + (bundle.access_expires || 60 * 60);
  refreshToken = bundle.refresh;
  refreshTokenExpiresAt = now + (bundle.refresh_expires || 30 * 24 * 60 * 60);

  return accessToken as string;
}

// Force fresh token fetch (ignores cache) for debug purposes; returns metadata only
export async function debugObtainTokenMeta() {
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

export async function listInstitutions(country: string) {
  const token = await ensureAccessToken();
  try {
    return await request<any[]>(`/institutions/?country=${encodeURIComponent(country)}`, {
      headers: { 'accept': 'application/json', 'Authorization': `Bearer ${token}` },
    });
  } catch (e: any) {
    if (DEBUG) console.error('[GoCardless][institutions] country', country, 'error:', e?.message);
    throw e;
  }
}

// Internal debug helper export (only to be used by debug routes)
export const __gocardlessDebug = { tokenState: _debugTokenState };

export async function createEndUserAgreement(institutionId: string, opts?: {
  max_historical_days?: number;
  access_valid_for_days?: number;
  access_scope?: ('balances' | 'details' | 'transactions')[];
}) {
  const token = await ensureAccessToken();
  const body = JSON.stringify({ institution_id: institutionId, ...opts });
  return request<any>('/agreements/enduser/', {
    method: 'POST',
    headers: { 'accept': 'application/json', 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
    body,
  });
}

export async function createRequisition(params: {
  redirect: string;
  institution_id: string;
  reference?: string;
  agreement?: string;
  user_language?: string; // ISO 639-1
}) {
  const token = await ensureAccessToken();
  const body = JSON.stringify(params);
  return request<any>('/requisitions/', {
    method: 'POST',
    headers: { 'accept': 'application/json', 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
    body,
  });
}

export async function getRequisition(requisitionId: string) {
  const token = await ensureAccessToken();
  return request<any>(`/requisitions/${encodeURIComponent(requisitionId)}/`, {
    headers: { 'accept': 'application/json', 'Authorization': `Bearer ${token}` },
  });
}

export async function getAccountDetails(accountId: string) {
  const token = await ensureAccessToken();
  return request<any>(`/accounts/${encodeURIComponent(accountId)}/details/`, {
    headers: { 'accept': 'application/json', 'Authorization': `Bearer ${token}` },
  });
}

export async function getAccountBalances(accountId: string) {
  const token = await ensureAccessToken();
  return request<any>(`/accounts/${encodeURIComponent(accountId)}/balances/`, {
    headers: { 'accept': 'application/json', 'Authorization': `Bearer ${token}` },
  });
}

export async function getAccountTransactions(accountId: string, params?: { date_from?: string; date_to?: string; fullHistoryDays?: number }) {
  const token = await ensureAccessToken();
  const qs = new URLSearchParams();

  // If no explicit range provided, default to last N days (env or 90)
  let dateFrom = params?.date_from;
  let dateTo = params?.date_to;
  const spanDays = params?.fullHistoryDays || Number(process.env.BANKDATA_DEFAULT_DAYS || 90);
  if (!dateFrom && !dateTo) {
    const today = new Date();
    const past = new Date(Date.now() - (spanDays - 1) * 24 * 60 * 60 * 1000);
    const fmt = (d: Date) => d.toISOString().slice(0, 10);
    dateFrom = fmt(past);
    dateTo = fmt(today);
  }
  if (dateFrom) qs.set('date_from', dateFrom);
  if (dateTo) qs.set('date_to', dateTo);

  const suffix = qs.toString() ? `?${qs.toString()}` : '';
  const url = `/accounts/${encodeURIComponent(accountId)}/transactions/${suffix}`;
  // Debug log for visibility (can be downgraded later)
  console.log('[getAccountTransactions] requesting', url);
  return request<any>(url, {
    headers: { 'accept': 'application/json', 'Authorization': `Bearer ${token}` },
  });
}
