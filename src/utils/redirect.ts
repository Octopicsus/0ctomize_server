/** Dynamic redirect URL resolver. */
export type RedirectMeta = { url: string; source: 'BANKDATA_REDIRECT_URL' | 'NGROK_URL' | 'ngrok:auto' | 'default'; ngrokPublicUrl?: string | null; refreshedAt: number; };
const CACHE_TTL_MS = 30000;
let cache: RedirectMeta | null = null;
const strip = (s: string) => s.replace(/\/$/, '');
async function detectNgrok(): Promise<RedirectMeta | null> {
  try {
    if (typeof fetch !== 'function') return null;
    const r = await fetch('http://127.0.0.1:4040/api/tunnels');
    if (!r.ok) return null;
    const j: any = await r.json();
    const tunnels: any[] = Array.isArray(j.tunnels) ? j.tunnels : [];
    const httpsTunnel = tunnels.find(t => typeof t.public_url === 'string' && t.public_url.startsWith('https://'));
    if (!httpsTunnel) return null;
    const base = strip(httpsTunnel.public_url);
    return { url: `${base}/api/bankdata/callback`, source: 'ngrok:auto', ngrokPublicUrl: base, refreshedAt: Date.now() };
  } catch { return null; }
}
export async function getRedirectMeta(): Promise<RedirectMeta> {
  const explicit = process.env.BANKDATA_REDIRECT_URL;
  if (explicit) return { url: strip(explicit), source: 'BANKDATA_REDIRECT_URL', ngrokPublicUrl: null, refreshedAt: Date.now() };
  const envNgrok = process.env.NGROK_URL;
  if (envNgrok) { const base = strip(envNgrok); return { url: `${base}/api/bankdata/callback`, source: 'NGROK_URL', ngrokPublicUrl: base, refreshedAt: Date.now() }; }
  if (cache && Date.now() - cache.refreshedAt < CACHE_TTL_MS) return cache;
  const auto = await detectNgrok();
  if (auto) { cache = auto; return auto; }
  cache = { url: 'http://localhost:3001/api/bankdata/callback', source: 'default', ngrokPublicUrl: null, refreshedAt: Date.now() };
  return cache;
}
export function getCachedRedirectUrl(): string | null { return cache?.url || null; }
