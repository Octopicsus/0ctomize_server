"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.getRedirectMeta = getRedirectMeta;
exports.getCachedRedirectUrl = getCachedRedirectUrl;
const CACHE_TTL_MS = 30000;
let cache = null;
const strip = (s) => s.replace(/\/$/, '');
async function detectNgrok() {
    try {
        if (typeof fetch !== 'function')
            return null;
        const r = await fetch('http://127.0.0.1:4040/api/tunnels');
        if (!r.ok)
            return null;
        const j = await r.json();
        const tunnels = Array.isArray(j.tunnels) ? j.tunnels : [];
        const httpsTunnel = tunnels.find(t => typeof t.public_url === 'string' && t.public_url.startsWith('https://'));
        if (!httpsTunnel)
            return null;
        const base = strip(httpsTunnel.public_url);
        return { url: `${base}/api/bankdata/callback`, source: 'ngrok:auto', ngrokPublicUrl: base, refreshedAt: Date.now() };
    }
    catch {
        return null;
    }
}
async function getRedirectMeta() {
    const explicit = process.env.BANKDATA_REDIRECT_URL;
    if (explicit)
        return { url: strip(explicit), source: 'BANKDATA_REDIRECT_URL', ngrokPublicUrl: null, refreshedAt: Date.now() };
    const envNgrok = process.env.NGROK_URL;
    if (envNgrok) {
        const base = strip(envNgrok);
        return { url: `${base}/api/bankdata/callback`, source: 'NGROK_URL', ngrokPublicUrl: base, refreshedAt: Date.now() };
    }
    if (cache && Date.now() - cache.refreshedAt < CACHE_TTL_MS)
        return cache;
    const auto = await detectNgrok();
    if (auto) {
        cache = auto;
        return auto;
    }
    cache = { url: 'http://localhost:3001/api/bankdata/callback', source: 'default', ngrokPublicUrl: null, refreshedAt: Date.now() };
    return cache;
}
function getCachedRedirectUrl() { return cache?.url || null; }
