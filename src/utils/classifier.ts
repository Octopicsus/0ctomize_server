// Simple rule-based transaction classifier aligned with existing income/expense categories.
// Uses only category titles defined in public/data/categories.json (mirrored here manually).

export interface ClassificationResult {
  category: string;
  confidence: number; // 0..1
  details?: { ruleHits: string[] };
}

interface Rule { category: string; patterns: (RegExp | string)[]; weight?: number }

// Expense categories available (extended):
// Taxes, Accounting, Insurance, Groceries, Rent, Utilities, Household, Services, Beauty,
// Health, Sports, Cafe, Shisha Cafe, Bar, Cinema, Fun, Clothing, Travel, Loan, Transport,
// Electronics, Renovation, Education, Transfers Send, Other
// Expanded with vendor / locale tokens (Ugo, Kavarna, Cinema City, Bolt, Ceske drahy, Nvidia, Alza, Github, etc.)
const EXPENSE_RULES: Rule[] = [
  // --- User supplied explicit merchant mappings (higher priority) ---
  { category: 'Cafe', patterns: [
    /\b(pelmen[ea]rna)\b/i,
    /\b(popeyes)\b/i,
    /\b(zestanku)\b/i,
    /\b(mr\.?\s*hot\s*d[og]{2})\b/i,
  /\b(automat\s*matush?ka)\b/i,
    /\b(tchibo)\b/i,
    /\b(new\s*food)\b/i,
  /\b(dahab\s*beas)\b/i, // earlier misspelling captured
  /\b(dhaba\s*beas)\b/i, // correct chain name
    /\b(alebr(i|ij)jes)\b/i,
    /\b(happy\s*food)\b/i,
    /\b(yes\s*cafe)\b/i,
    /\b(yes\s*kakewine)\b/i,
  /\b(yes\s*kafewine)\b/i,
    /\b(mon\s*ami)\b/i,
    /\b(baden\s*baden)\b/i, // (also Beauty below; cafe takes precedence per user)
  /\b(letensk[y\s]*zamecek)\b/i, // Letensky Zamecek (with or without space/diacritics removed)
    /\b(cernomork)\b/i,
    /\b(bonveno)\b/i,
    /\b(las\s*adelitas)\b/i,
    /\b(bageterie)\b/i,
    /\b(calzedonia)\b/i, // user requested Cafe (brand is clothing but honoring request)
    /\b(tiskarna)\b/i,
    /\b(puro\s*gelato)\b/i,
    /\b(prosekarna)\b/i,
    /\b(u\s*brachy|u\s*bracu)\b/i,
    /\b(sun\s*day\s*terrace)\b/i,
  /\b(fontana)\b/i,
  /\b(creperie\s*mirakulum)\b/i,
  /\b(mcdonalds?)\b/i,
  /\b(tepla\s*kacka)\b/i,
  /\b(skyy?va)\b/i,
  /\b(picnic)\b/i,
  /\b(zlat[y\s]*andel)\b/i,
  ], weight: 1.35 },
  { category: 'Transport', patterns: [/\b(east\s*express)\b/i], weight: 1.3 },
  { category: 'Groceries', patterns: [
    /\b(pont\s*florenc(e)?)\b/i, // Pont Florenc / Pont Florence
    /\b(penny)\b/i,
    /\b(vecerka)\b/i,
    /\b(potraviny)\b/i,
    /\b(alkoholcz)\b/i,
    /\b(globe)\b/i,
    /\b(pivo\s*grando)\b/i,
  /\b(c\.i\.p\.a|cipa)\b/i,
  /c[\s\.]?i[\s\.]?p[\s\.]?a/iu // C I P A with spaces/dots
  ], weight: 1.3 },
  { category: 'Clothing', patterns: [/\b(halfprice)\b/i, /\b(celio)\b/i, /\b(cropp)\b/i], weight: 1.25 },
  { category: 'Beauty', patterns: [/\b(baden\s*baden)\b/i, /\b(sauny?)\b/i], weight: 1.25 },
  { category: 'Household', patterns: [/\b(domaci\s*potreby)\b/i, /\b(rossmann?)\b/i], weight: 1.2 },
  { category: 'Services', patterns: [/\b(gopay)\b/i, /\batm\b/i], weight: 1.2 },
  { category: 'Groceries', patterns: [/\b(lidl|tesco|kaufland|billa|zabka|carrefour|aldi|albert|relay|ovoce|zelenina|shin|mastro\s*(cesar[o]?|casar[o]?))\b/i], weight: 1.25 },
  { category: 'Cafe', patterns: [/\b(starbucks|mcdonald|mcd|kfc|subway|pizza|burger\s*king|paul|cafe|xcafe|xkafe|restaurant|coffee|espresso|bakehouse|kavarn[aá]?|truhlarna|zrno\s*zrnko|angelato|bistro|botticelli|deli\s*viet|tisse|bastova|zmrzlinarna|ugo|salaterie|i\s*love\s*you|chateau|polevkarna|vnitroblock|kellyxir|the\s*borsch|borsch|borsh|indian\s*indeal)\b/i] },
  { category: 'Shisha Cafe', patterns: [/\b(myata|hookkaido|shisha)\b/i], weight: 1.3 },
  { category: 'Bar', patterns: [/\b(bar|lounge|pub|tankovna|pivovar)\b/i] },
  { category: 'Cinema', patterns: [/\b(cinema\s*city|cinema|cinemacity|cinestar|movie|film)\b/i], weight: 1.2 },
  { category: 'Transport', patterns: [/\b(uber|bolt(\.eu)?|metro|tram|bus|ticket|transport|train|flixbus|cesk[eé]\s*drah|\bcd\b|n[aá]dra[zž])\b/i] },
  { category: 'Fun', patterns: [/\b(game\s*pass|concert|theatre)\b/i] },
  { category: 'Services', patterns: [/\b(subscription|subscrip|recurring|service|hosting|domain|github|netflix|spotify|youtube|google|nvidia|foodora)\b/i], weight: 1.1 },
  { category: 'Utilities', patterns: [/\b(electric|water|gas|utility|internet|telecom|vodafone|t-mobile|o2)\b/i] },
  { category: 'Health', patterns: [/\b(pharmacy|lekarna|lekarn[aey]?|apteka|drugstore|clinic|dentist|hospital)\b/i] },
  { category: 'Taxes', patterns: [/\b(tax|vat)\b/i] },
  { category: 'Insurance', patterns: [/\b(insurance|insur|policy|vzp)\b/i] },
  { category: 'Loan', patterns: [/\b(loan|credit payment|repayment|mortgage)\b/i] },
  { category: 'Travel', patterns: [/\b(airlines?|flight|hotel|booking\.com|airbnb|travel)\b/i] },
  { category: 'Clothing', patterns: [/\b(h&m|zara|nike|adidas|clothing|fashion|outfit|uniqlo)\b/i] },
  { category: 'Education', patterns: [/\b(course|udemy|coursera|education|school|university|tuition)\b/i] },
  { category: 'Beauty', patterns: [/\b(salon|cosmetic|beauty|spa|nails|haircut|barber)\b/i] },
  { category: 'Sports', patterns: [/\b(gym|fitness|sport|workout|yoga|plave(c|ck|cky)|stadion|decathlon)\b/i], weight: 1.3 },
  { category: 'Household', patterns: [/\b(ikea|household|home\s*center|homeware|furniture|tescoma|teta|dm|drogerie)\b/i] },
  { category: 'Electronics', patterns: [/\b(alza|datart|electronics|megapixel)\b/i], weight: 1.25 },
  { category: 'Renovation', patterns: [/\b(renovation|repair|hardware\s*store|bauhaus|obi)\b/i] },
  { category: 'Accounting', patterns: [/\b(accounting|bookkeep|accountant)\b/i] },
  { category: 'Transfers Send', patterns: [/\b(transfer|wire)\b/i], weight: 0.2 },
  { category: 'Other', patterns: [/./], weight: 0.05 } // lowest fallback
];

// Income categories available:
// Salary, Bonus, Investments, Revenue, Fee, Dividends, Pension, Inheritance, Rent Income, Exchange, Refound, Other
const INCOME_RULES: Rule[] = [
  // New: mark bank refunds "Refund From ..." as 'Refound'
  { category: 'Refound', patterns: [/\brefund\s*from\b/i], weight: 1.3 },
  { category: 'Salary', patterns: [/\b(payroll|salary|wage|hr payment|paycheck)\b/i], weight: 1.3 },
  { category: 'Bonus', patterns: [/\b(bonus|award|incentive)\b/i] },
  { category: 'Investments', patterns: [/\b(investment|invest|capital gain)\b/i] },
  { category: 'Dividends', patterns: [/\b(dividend|dist\.?|dividends)\b/i] },
  { category: 'Pension', patterns: [/\b(pension|retire)\b/i] },
  { category: 'Inheritance', patterns: [/\b(inheritance|estate)\b/i] },
  { category: 'Rent Income', patterns: [/\b(rent payment|rent income|tenant)\b/i] },
  { category: 'Revenue', patterns: [/\b(revenue|sale|sales)\b/i] },
  { category: 'Fee', patterns: [/\b(fee|commission|charge)\b/i] },
  { category: 'Other', patterns: [/./], weight: 0.1 }
];

const NORMALIZE_RE = /[^a-z0-9\s]+/gi;

// Remove diacritics for more robust matching (kavárna -> kavarna, nádraží -> nadrazi)
function stripDiacritics(str: string) {
  return str.normalize('NFD').replace(/\p{Diacritic}/gu, '');
}

export function classifyTransactionText(title: string, description: string | undefined, txType: 'Expense' | 'Income'): ClassificationResult {
  const raw = `${title || ''} ${description || ''}`.toLowerCase();
  const normalized = stripDiacritics(raw).replace(NORMALIZE_RE, ' ');
  let bestCategory = 'Uncategorized';
  let bestScore = 0;
  const hits: string[] = [];
  const rules = txType === 'Income' ? INCOME_RULES : EXPENSE_RULES;

  for (const rule of rules) {
    let score = 0;
    for (const p of rule.patterns) {
      if (p instanceof RegExp) {
        if (p.test(normalized)) {
          score += 1;
          hits.push(`${rule.category}:${p.toString()}`);
        }
      } else {
        if (normalized.includes(p.toLowerCase())) {
          score += 0.7;
          hits.push(`${rule.category}:'${p}'`);
        }
      }
    }
    if (score > 0) score *= (rule.weight || 1);
    if (score > bestScore) {
      bestScore = score;
      bestCategory = rule.category;
    }
  }

  // Confidence heuristic: map score range (0..maxObserved) to 0..1
  const maxTheoretical = 3; // small cap to avoid >1
  const confidence = Math.min(bestScore / maxTheoretical, 1);
  return { category: bestCategory, confidence, details: { ruleHits: hits } };
}

export interface AutoCategoryFields {
  category?: string;
  categoryConfidence?: number;
  categorySource?: 'auto' | 'manual' | 'rule' | 'llm' | 'override';
  categoryReason?: string; // optional explanation (rule hits / LLM reason / override rationale)
  categoryVersion?: number; // for future migrations
}

export function autoClassify(doc: { title?: string; description?: string; type?: 'Expense' | 'Income' }): AutoCategoryFields {
  const title = doc.title || '';
  const description = doc.description || '';
  const txType: 'Expense' | 'Income' = doc.type === 'Income' ? 'Income' : 'Expense';
  const { category, confidence, details } = classifyTransactionText(title, description, txType);
  if (category === 'Uncategorized') {
    return { category, categoryConfidence: confidence, categorySource: 'rule', categoryReason: 'no rule hit', categoryVersion: 2 };
  }
  const reason = details?.ruleHits?.slice(0,5).join('; ') || 'rule match';
  return { category, categoryConfidence: confidence, categorySource: 'rule', categoryReason: reason, categoryVersion: 2 };
}
