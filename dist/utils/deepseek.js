"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.llmClassifyTransaction = llmClassifyTransaction;
exports.llmClassifyTransactionsBatch = llmClassifyTransactionsBatch;
exports.llmNormalizeMerchantTitle = llmNormalizeMerchantTitle;
const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions';
// Allow overriding model via env; default switched to improved chimera variant
const MODEL = process.env.OPENROUTER_MODEL || 'tngtech/deepseek-r1t2-chimera:free';
const REQUEST_TIMEOUT_MS = 10000;
const CACHE_MAX_ENTRIES = 500;
const classificationCache = new Map();
const merchantTitleCache = new Map();
function cacheKey(title, description, txType) {
    return `${txType}|${title.toLowerCase()}|${(description || '').toLowerCase()}`.slice(0, 500);
}
const EXPENSE_CATEGORIES = [
    'Taxes', 'Accounting', 'Insurance', 'Groceries', 'Rent', 'Utilities', 'Household', 'Services', 'Beauty',
    'Transfers Send', 'Shisha Cafe', 'Cinema', 'Health', 'Sports', 'Cafe', 'Bar', 'Fun', 'Clothing', 'Travel',
    'Loan', 'Electronics', 'Transport', 'Renovation', 'Education', 'Other'
];
const INCOME_CATEGORIES = [
    'Salary', 'Bonus', 'Investments', 'Revenue', 'Fee', 'Dividends', 'Pension', 'Inheritance', 'Rent Income',
    'Transfers Get', 'Other'
];
const CATEGORY_PROMPTS = {
    Expense: `Choose the SINGLE best category from this exact list: ${EXPENSE_CATEGORIES.join(', ')}.`,
    Income: `Choose the SINGLE best category from this exact list: ${INCOME_CATEGORIES.join(', ')}.`
};
const THINK_TAGS_REGEX = /<think>[\s\S]*?<\/think>/g;
const JSON_REGEX = /\{[\s\S]*\}/;
function sanitizeModelOutput(raw) {
    try {
        const cleaned = raw.replace(THINK_TAGS_REGEX, '').trim();
        const jsonMatch = cleaned.match(JSON_REGEX);
        if (!jsonMatch)
            return null;
        const parsed = JSON.parse(jsonMatch[0]);
        if (typeof parsed.category !== 'string' || !parsed.category)
            return null;
        let confidence = 0.5;
        if (typeof parsed.confidence === 'number') {
            confidence = Math.max(0, Math.min(1, parsed.confidence));
        }
        return {
            category: parsed.category,
            confidence,
            reason: typeof parsed.reason === 'string' ? parsed.reason : ''
        };
    }
    catch {
        return null;
    }
}
function createSystemPrompt(txType) {
    return `You are a financial transaction categorization assistant. Analyze transaction details (merchant/title + optional description) and return ONLY valid JSON. Some merchant names can be Czech (diacritics may be missing). Normalize mentally but DO NOT output normalized text—only the JSON.
\n${CATEGORY_PROMPTS[txType]}\n\nGUIDELINES:\n1. STRICT JSON ONLY: {"category":"Exact_Category_Name","confidence":0.0-1.0,"reason":"brief decisive keyword(s)"}\n2. Confidence: 0.0 (wild guess) to 1.0 (certain). Use <=0.40 if weak / ambiguous.\n3. If unsure OR no strong keyword mapping -> 'Other'.\n4. Use EXACT category names provided (case sensitive). Never invent.\n5. 'Transfers Send' / 'Transfers Get' ONLY for P2P or generic bank transfers (not purchases, not refunds).\n6. Streaming / video / music platforms (netflix, spotify, youtube) and general online digital subscriptions (google services, nvidia, github, domain, hosting) -> Services (NOT Fun).\n7. Fun = entertainment events (concert, theatre), game pass, generic leisure that is not a subscription service and not clearly Cinema (which is for movie theaters) and not Bar/Cafe.\n8. Shisha / hookah lounges (myata, hookkaido, shisha) -> Shisha Cafe. Alcohol-focused pubs / bars / pivovar -> Bar.\n9. Czech merchant hints: 'polévkárna'/'polevkarna' (soup place) -> Cafe; 'salaterie' or 'ugo' (salad/juice bar) -> Cafe; 'ovoce', 'zelenina' (fruit/veg stalls) -> Groceries; 'lekárna'/'lekarn'/'apteka' -> Health; 'pojišťovna'/'pojistovna'/'vzp' -> Insurance; 'plavec', 'plavecký', 'plavecky' (swim) -> Sports.\n10. Additional Cafe examples: bistro, borsh/ borsch / the borsch, botticelli, bastova/bastovna, vnitroblock, kellyxir, deli viet, tisse, i love you, chateau, polevkarna (again), xcafe / xkafe.\n11. Electronics examples: alza, datart, megapixel (nvidia itself now treated as Services subscription / platform, NOT Electronics).\n12. Mention in reason the decisive token(s) you matched (e.g. token='polevkarna' => Cafe).\n13. Output JUST one JSON object with no extra text, no markdown.\n`;
}
async function llmClassifyTransaction(title, description, txType) {
    const apiKey = process.env.DEEPSEEK_SECRET_KEY;
    if (!apiKey) {
        return null;
    }
    if (!title || typeof title !== 'string')
        return null;
    const categories = txType === 'Income' ? INCOME_CATEGORIES : EXPENSE_CATEGORIES;
    const key = cacheKey(title, description, txType);
    if (classificationCache.has(key)) {
        return classificationCache.get(key);
    }
    const userContent = `Title: ${title}\nDescription: ${description || 'No description'}\nType: ${txType}`;
    try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
        const resp = await fetch(OPENROUTER_URL, {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${apiKey}`,
                'Content-Type': 'application/json',
                'HTTP-Referer': process.env.SITE_URL || 'https://your-app.example',
                'X-Title': 'Financial Categorizer'
            },
            body: JSON.stringify({
                model: MODEL,
                temperature: 0.1,
                max_tokens: 150,
                messages: [
                    { role: 'system', content: createSystemPrompt(txType) },
                    { role: 'user', content: userContent }
                ]
            }),
            signal: controller.signal
        });
        clearTimeout(timeoutId);
        if (!resp.ok) {
            console.error(`OpenRouter API error: ${resp.status} ${resp.statusText}`);
            return null;
        }
        const data = await resp.json();
        const content = data?.choices?.[0]?.message?.content;
        if (!content)
            return null;
        const parsed = sanitizeModelOutput(content);
        if (!parsed)
            return null;
        if (!categories.includes(parsed.category)) {
            return null;
        }
        const result = {
            category: parsed.category,
            categoryConfidence: parsed.confidence,
            categorySource: 'llm',
            categoryReason: parsed.reason,
            categoryVersion: 2
        };
        classificationCache.set(key, result);
        if (classificationCache.size > CACHE_MAX_ENTRIES) {
            // drop oldest ~10%
            const drop = Math.ceil(CACHE_MAX_ENTRIES * 0.1);
            for (const k of Array.from(classificationCache.keys()).slice(0, drop)) {
                classificationCache.delete(k);
            }
        }
        return result;
    }
    catch (e) {
        if (e?.name === 'AbortError') {
            console.error('DeepSeek classification request timed out');
        }
        else {
            console.error('DeepSeek classify error:', e?.message || e);
        }
        return null;
    }
}
async function llmClassifyTransactionsBatch(transactions) {
    const results = [];
    for (const tx of transactions) {
        const r = await llmClassifyTransaction(tx.title, tx.description, tx.txType);
        results.push(r);
        await new Promise(res => setTimeout(res, 100));
    }
    return results;
}
// -------- Merchant Title Normalization --------
// Produces a canonical establishment/service name without numbers, dates, city/area qualifiers.
// Returns plain string (no JSON wrappers) limited to 40 chars.
async function llmNormalizeMerchantTitle(rawTitle, description) {
    const apiKey = process.env.DEEPSEEK_SECRET_KEY;
    if (!apiKey)
        return simpleTitleSanitize(rawTitle);
    if (!rawTitle)
        return null;
    const key = `norm|${rawTitle.toLowerCase()}|${(description || '').toLowerCase()}`.slice(0, 400);
    if (merchantTitleCache.has(key))
        return merchantTitleCache.get(key);
    const system = `Extract ONLY the core merchant / service / venue brand name from a bank transaction title.
Rules:
- Remove numbers, amounts, dates, timestamps, payment codes, excessive punctuation.
- Remove city / district / country words (praha, prague, cz, czech, brno, ostrava, berlin, wien, vienna, munich, krakow, paris) and address fragments (ul., ulice, street, strasse, plzen, vinohrady, smichov, karlin, letna, stare mesto, nova, centrum).
- Keep diacritics if present; do not fabricate.
- Output ONLY the cleaned merchant/service name, NO JSON, NO quotes.
- If multiple words, keep concise brand (max 4 words, <= 40 chars).
- If looks like generic transfer (contains 'transfer' or 'prevod') return 'Transfer'.
Examples:
'PURO GELATO PRAHA 2' -> 'Puro Gelato'
'ALZA PRAHA HOLEŠOVICE' -> 'Alza'
'NETFLIX.COM 123456' -> 'Netflix'
'GOOGLE *YOUTUBE PREMIUM' -> 'YouTube Premium'
'TRANSFER TO JOHN' -> 'Transfer'
`;
    const user = `Title: ${rawTitle}\nDescription: ${description || 'None'}`;
    try {
        const resp = await fetch(OPENROUTER_URL, {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${apiKey}`,
                'Content-Type': 'application/json',
                'HTTP-Referer': process.env.SITE_URL || 'https://your-app.example',
                'X-Title': 'Merchant Normalizer'
            },
            body: JSON.stringify({
                model: MODEL,
                temperature: 0.1,
                max_tokens: 40,
                messages: [
                    { role: 'system', content: system },
                    { role: 'user', content: user }
                ]
            })
        });
        if (!resp.ok)
            return simpleTitleSanitize(rawTitle);
        const data = await resp.json();
        let content = data?.choices?.[0]?.message?.content || '';
        content = content.replace(THINK_TAGS_REGEX, '').trim();
        content = content.split('\n')[0].trim();
        if (!content)
            return simpleTitleSanitize(rawTitle);
        const cleaned = postSanitizeMerchant(content);
        merchantTitleCache.set(key, cleaned);
        if (merchantTitleCache.size > CACHE_MAX_ENTRIES) {
            for (const k of Array.from(merchantTitleCache.keys()).slice(0, Math.ceil(CACHE_MAX_ENTRIES * 0.1)))
                merchantTitleCache.delete(k);
        }
        return cleaned;
    }
    catch {
        return simpleTitleSanitize(rawTitle);
    }
}
function simpleTitleSanitize(t) {
    return postSanitizeMerchant(t)
        .replace(/\d+/g, '')
        .replace(/\s{2,}/g, ' ') // collapse spaces
        .trim()
        .slice(0, 40);
}
function postSanitizeMerchant(t) {
    // Brand canonicalization (early exit)
    if (/\bkfc\b/i.test(t)) {
        return 'KFC';
    }
    if (/www\.cd\b|cd\.cz\b/i.test(t)) {
        return 'CD';
    }
    // Collapse spaced/dotted brand letters (e.g. C. I. P. A -> Cipa)
    t = t.replace(/c[\s\.]?i[\s\.]?p[\s\.]?a/gi, 'Cipa');
    let s = t
        .replace(/[_*#<>"'`]/g, ' ')
        .replace(/\d{2,}/g, '')
        .replace(/\b(praha|prague|cz|czech|brno|ostrava|berlin|wien|vienna|munich|krakow|paris|vinohrady|smichov|karlin|letna|centrum|stare\s*mesto|nova)\b/gi, '')
        .replace(/\b(ul\.?|ulice|street|strasse|tr\.?|nam\.?|square)\b/gi, '')
        .replace(/\b(spol\.?\s*s\s*r\.?\s*o\.?|s\s*r\.?\s*o\.?|s\.r\.o\.)\b/gi, '') // remove corporate suffix
        .replace(/\s{2,}/g, ' ')
        .trim();
    // Capitalize first letters of words up to 4 words
    s = s.split(' ').filter(Boolean).slice(0, 4).map(w => w.length > 3 ? w[0].toUpperCase() + w.slice(1).toLowerCase() : w[0].toUpperCase() + w.slice(1).toLowerCase()).join(' ');
    if (!s)
        s = 'Transaction';
    return s.slice(0, 40);
}
