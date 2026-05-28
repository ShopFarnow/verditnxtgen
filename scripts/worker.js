/**
 * worker.js — VerdictNxtGen Enterprise Worker v4
 *
 * NEW IN v4:
 *  - API key authentication (X-API-Key header or ?api_key=)
 *  - Rate limiting per key (Cloudflare KV)
 *  - /batch endpoint (up to 20 companies, CSV-friendly)
 *  - /keys/register endpoint (self-serve API key generation)
 *  - Usage tracking per key (KV)
 *  - Tiered limits: free=10/day, pro=500/day, enterprise=unlimited
 *  - Abuse protection: IP-based fallback if no key
 *  - White-label support (X-Brand header strips VerdictNxtGen branding)
 *  - Replaced NewsAPI with GNews (500/day free) + fallback to RSS
 *  - OpenCorporates caching (KV, 24h TTL) to avoid rate limits
 *  - /health endpoint with uptime data
 *
 * Cloudflare env vars:
 *   OPENAI_API_KEY     (secret)
 *   GNEWS_API_KEY      (secret)  ← replaces NewsAPI, 500 req/day free
 *   PINECONE_API_KEY   (secret)
 *   PINECONE_HOST      (secret)
 *   VERDITNXTGEN_TOKEN (secret)  GitHub PAT
 *   GITHUB_REPO        (text)    ShopFarnow/verditnxtgen
 *   MASTER_SECRET      (secret)  used to sign generated API keys
 *   KV_STORE           (KV namespace binding) ← bind in Cloudflare dashboard
 */

const CORS_OPEN = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, X-API-Key, X-Brand',
  'Content-Type': 'application/json',
};

// Tier definitions
const TIERS = {
  free:       { daily: 10,    batch: 0,    label: 'Free' },
  pro:        { daily: 500,   batch: 20,   label: 'Pro' },
  enterprise: { daily: 99999, batch: 100,  label: 'Enterprise' },
  internal:   { daily: 99999, batch: 100,  label: 'Internal' },
};

// ─────────────────────────────────────────────────────────────
//  ROUTER
// ─────────────────────────────────────────────────────────────
export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS_OPEN });

    // ── Auth & rate limit (all endpoints except /health & /keys/register) ──
    let apiKeyData = null;
    if (!['/health', '/keys/register'].includes(url.pathname)) {
      const authResult = await authenticate(request, env);
      if (authResult.error) return json({ error: authResult.error, docs: 'https://verditnxtgen.com/api-docs' }, 401);
      apiKeyData = authResult;

      // Rate limit check
      const limited = await checkRateLimit(apiKeyData, env);
      if (limited) return json({
        error: 'Rate limit exceeded',
        tier: apiKeyData.tier,
        limit: TIERS[apiKeyData.tier]?.daily,
        reset: 'midnight UTC',
        upgrade: 'https://verditnxtgen.com/#pricing'
      }, 429);
    }

    // ── Route ──────────────────────────────────────────────
    if (url.pathname === '/check')         return handleCheck(url.searchParams.get('q'), request, apiKeyData, env, ctx);
    if (url.pathname === '/batch' && request.method === 'POST') return handleBatch(request, apiKeyData, env, ctx);
    if (url.pathname === '/keys/register' && request.method === 'POST') return handleRegisterKey(request, env);
    if (url.pathname === '/usage')         return handleUsage(apiKeyData, env);
    if (url.pathname === '/health')        return handleHealth(env);

    return json({ error: 'Not found', endpoints: ['/check', '/batch', '/usage', '/health', '/keys/register'] }, 404);
  }
};

// ─────────────────────────────────────────────────────────────
//  AUTHENTICATION
//  Accepts: X-API-Key header OR ?api_key= query param
//  No key = free tier with IP-based rate limiting
// ─────────────────────────────────────────────────────────────
async function authenticate(request, env) {
  const url = new URL(request.url);
  const key = request.headers.get('X-API-Key') || url.searchParams.get('api_key');

  // No key: give free tier, use IP as identifier
  if (!key) {
    const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
    return { key: `ip:${ip}`, tier: 'free', email: null, anonymous: true };
  }

  // Validate key from KV
  if (!env.KV_STORE) {
    // KV not configured: accept any key as pro (dev mode)
    return { key, tier: 'pro', email: 'dev@verditnxtgen.com', anonymous: false };
  }

  const stored = await env.KV_STORE.get(`apikey:${key}`, { type: 'json' });
  if (!stored) return { error: 'Invalid API key. Register at https://verditnxtgen.com/api-docs' };
  if (stored.suspended) return { error: 'API key suspended. Contact hello@verditnxtgen.com' };

  return { key, tier: stored.tier || 'free', email: stored.email, anonymous: false, ...stored };
}

// ─────────────────────────────────────────────────────────────
//  RATE LIMITING (Cloudflare KV with daily TTL)
// ─────────────────────────────────────────────────────────────
async function checkRateLimit(keyData, env) {
  if (!env.KV_STORE) return false; // KV not configured, skip
  const tier = TIERS[keyData.tier] || TIERS.free;
  if (tier.daily >= 99999) return false; // enterprise = unlimited

  const today = new Date().toISOString().split('T')[0];
  const kvKey = `usage:${keyData.key}:${today}`;
  const current = parseInt(await env.KV_STORE.get(kvKey) || '0');

  if (current >= tier.daily) return true; // rate limited

  // Increment (expires at end of day — 86400s TTL max, use seconds til midnight)
  const now = new Date();
  const midnight = new Date(now); midnight.setUTCHours(24, 0, 0, 0);
  const ttl = Math.floor((midnight - now) / 1000);
  await env.KV_STORE.put(kvKey, String(current + 1), { expirationTtl: ttl });
  return false;
}

// ─────────────────────────────────────────────────────────────
//  /check — single company verification
// ─────────────────────────────────────────────────────────────
async function handleCheck(query, request, keyData, env, ctx) {
  if (!query || query.trim().length < 2) return json({ error: 'Query too short. Minimum 2 characters.' }, 400);
  const q = query.trim();
  const whiteLabel = request.headers.get('X-Brand'); // enterprise white-label

  const result = await verifyCompany(q, env);
  return json({
    ...result,
    _meta: {
      tier: keyData.tier,
      white_label: whiteLabel || null,
      powered_by: whiteLabel ? null : 'VerdictNxtGen',
    }
  });
}

// ─────────────────────────────────────────────────────────────
//  /batch — verify up to 20 companies at once (Pro+)
// ─────────────────────────────────────────────────────────────
async function handleBatch(request, keyData, env, ctx) {
  const tier = TIERS[keyData.tier] || TIERS.free;
  if (tier.batch === 0) {
    return json({
      error: 'Batch verification requires Pro or Enterprise plan',
      upgrade: 'https://verditnxtgen.com/#pricing'
    }, 403);
  }

  let body;
  try { body = await request.json(); } catch(e) { return json({ error: 'Invalid JSON body' }, 400); }

  const companies = Array.isArray(body.companies) ? body.companies : [];
  if (!companies.length) return json({ error: 'Provide { "companies": ["Company A", "Company B"] }' }, 400);
  if (companies.length > tier.batch) {
    return json({ error: `Batch limit is ${tier.batch} for ${tier.label} tier. Got ${companies.length}.` }, 400);
  }

  // Run all verifications in parallel (with concurrency limit of 5)
  const results = [];
  const chunks = [];
  for (let i = 0; i < companies.length; i += 5) chunks.push(companies.slice(i, i + 5));

  for (const chunk of chunks) {
    const chunkResults = await Promise.all(chunk.map(name => verifyCompany(name, env)));
    results.push(...chunkResults);
  }

  return json({
    total: results.length,
    summary: {
      verified: results.filter(r => r.verdict === 'verified').length,
      caution:  results.filter(r => r.verdict === 'caution').length,
      fraud:    results.filter(r => r.verdict === 'fraud').length,
    },
    results,
    _meta: { tier: keyData.tier, powered_by: 'VerdictNxtGen' }
  });
}

// ─────────────────────────────────────────────────────────────
//  /keys/register — self-serve API key generation
// ─────────────────────────────────────────────────────────────
async function handleRegisterKey(request, env) {
  let body;
  try { body = await request.json(); } catch(e) { return json({ error: 'Invalid JSON' }, 400); }

  const { email, plan } = body;
  if (!email || !email.includes('@')) return json({ error: 'Valid email required' }, 400);

  const tier = ['free', 'pro', 'enterprise'].includes(plan) ? plan : 'free';

  // Generate API key
  const raw = `${email}:${Date.now()}:${Math.random()}`;
  const keyBuffer = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(raw));
  const keyHex = Array.from(new Uint8Array(keyBuffer)).map(b => b.toString(16).padStart(2, '0')).join('');
  const apiKey = `vng_${tier[0]}_${keyHex.slice(0, 32)}`;

  // Store in KV
  if (env.KV_STORE) {
    await env.KV_STORE.put(`apikey:${apiKey}`, JSON.stringify({
      email, tier,
      created: new Date().toISOString(),
      suspended: false,
    }));
    // Also index by email
    await env.KV_STORE.put(`email:${email}`, apiKey);
  }

  return json({
    api_key: apiKey,
    tier,
    daily_limit: TIERS[tier].daily,
    batch_limit: TIERS[tier].batch,
    docs: 'https://verditnxtgen.com/api-docs',
    note: tier === 'free'
      ? 'Free tier: 10 requests/day. Upgrade at https://verditnxtgen.com/#pricing'
      : `${tier} tier active. Contact hello@verditnxtgen.com to activate payment.`
  });
}

// ─────────────────────────────────────────────────────────────
//  /usage — show current usage for this key
// ─────────────────────────────────────────────────────────────
async function handleUsage(keyData, env) {
  const today = new Date().toISOString().split('T')[0];
  let used = 0;
  if (env.KV_STORE) {
    used = parseInt(await env.KV_STORE.get(`usage:${keyData.key}:${today}`) || '0');
  }
  const tier = TIERS[keyData.tier] || TIERS.free;
  return json({
    key:       keyData.anonymous ? '(anonymous IP)' : keyData.key?.slice(0, 12) + '...',
    tier:      keyData.tier,
    email:     keyData.email || null,
    today:     today,
    used:      used,
    limit:     tier.daily,
    remaining: Math.max(0, tier.daily - used),
    batch_limit: tier.batch,
  });
}

// ─────────────────────────────────────────────────────────────
//  /health — uptime & status page data
// ─────────────────────────────────────────────────────────────
async function handleHealth(env) {
  const checks = await Promise.allSettled([
    fetch('https://en.wikipedia.org/w/api.php?action=query&list=search&srsearch=test&format=json&origin=*', { signal: AbortSignal.timeout(2000) }),
    fetch('https://api.opencorporates.com/v0.4/companies/search?q=test&format=json', { signal: AbortSignal.timeout(2000) }),
    fetch('https://who-dat.as93.net/google.com', { signal: AbortSignal.timeout(2000) }),
  ]);
  return json({
    status: 'operational',
    version: '4.0',
    timestamp: new Date().toISOString(),
    services: {
      wikipedia:       checks[0].status === 'fulfilled' && checks[0].value.ok ? 'up' : 'degraded',
      opencorporates:  checks[1].status === 'fulfilled' && checks[1].value.ok ? 'up' : 'degraded',
      whois:           checks[2].status === 'fulfilled' && checks[2].value.ok ? 'up' : 'degraded',
    }
  });
}

// ─────────────────────────────────────────────────────────────
//  CORE VERIFICATION ENGINE (same as v3 + KV caching)
// ─────────────────────────────────────────────────────────────
async function verifyCompany(name, env) {
  const cacheKey = `result:${name.toLowerCase().replace(/[^a-z0-9]/g, '')}`;

  // Check KV cache first (1 hour TTL) — saves API quota
  if (env.KV_STORE) {
    const cached = await env.KV_STORE.get(cacheKey, { type: 'json' });
    if (cached && cached.updated === new Date().toISOString().split('T')[0]) {
      return { ...cached, source: 'kv_cache' };
    }
  }

  const timeout = (p, ms) => Promise.race([p, new Promise(r => setTimeout(() => r(null), ms))]);

  const [wiki, corp, whois, news] = await Promise.all([
    timeout(fetchWikipedia(name), 4000),
    timeout(fetchOpenCorporates(name, env), 4000),
    timeout(fetchDomainAge(name), 3500),
    timeout(fetchNews(name, env), 4000),
  ]);

  const signals = mergeSignals(null, wiki, corp, whois, news);
  const { score, flags } = score100(signals);
  const verdict = score >= 75 ? 'verified' : score >= 45 ? 'caution' : 'fraud';
  const summary = await timeout(generateSummary(name, signals, score, verdict, flags, env), 4000)
                  || buildFallbackSummary(name, verdict);

  const result = {
    found: true,
    source: 'live',
    name: wiki?.title || corp?.name || name,
    score, verdict, flags, signals, summary,
    updated: new Date().toISOString().split('T')[0],
    data_sources: {
      wikipedia:      wiki  ? 'ok' : 'miss',
      opencorporates: corp  ? 'ok' : 'miss',
      whois:          whois ? 'ok' : 'miss',
      news:           news  ? 'ok' : 'miss',
    }
  };

  // Cache result in KV for 1 hour to save API quota
  if (env.KV_STORE) {
    await env.KV_STORE.put(cacheKey, JSON.stringify(result), { expirationTtl: 3600 });
  }

  // Save to GitHub cache in background
  saveToGitHub(name, result, env).catch(() => {});

  return result;
}

// ─────────────────────────────────────────────────────────────
//  DATA SOURCES (same as v3, unchanged)
// ─────────────────────────────────────────────────────────────
async function fetchWikipedia(name) {
  try {
    const UA = 'VerdictNxtGen/4.0 (verditnxtgen.com; hello@verditnxtgen.com)';
    const sr = await fetch(`https://en.wikipedia.org/w/api.php?action=query&list=search&srsearch=${encodeURIComponent(name + ' company')}&srlimit=3&format=json&origin=*`, { headers: { 'User-Agent': UA } });
    if (!sr.ok) return null;
    const sd = await sr.json();
    const hits = sd?.query?.search || [];
    if (!hits.length) return null;
    const best = hits.find(h => h.title.toLowerCase().includes(name.toLowerCase().split(' ')[0])) || hits[0];
    const sumRes = await fetch(`https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(best.title)}`, { headers: { 'User-Agent': UA } });
    if (!sumRes.ok) return null;
    const sum = await sumRes.json();
    const wikiRes = await fetch(`https://en.wikipedia.org/w/api.php?action=query&titles=${encodeURIComponent(best.title)}&prop=revisions&rvprop=content&rvsection=0&rvslots=main&format=json&origin=*`, { headers: { 'User-Agent': UA } });
    const wikiData = await wikiRes.json();
    const pages = wikiData?.query?.pages || {};
    const content = Object.values(pages)[0]?.revisions?.[0]?.slots?.main?.['*'] || '';
    const founded = extractWikiField(content, ['founded','founded_date','establishment']) || sum.extract?.match(/founded in (\d{4})/i)?.[1];
    const empMatch = extractWikiField(content, ['num_employees','employees','num_members']);
    const employees = empMatch ? parseInt(String(empMatch).replace(/[^\d]/g,'')) : null;
    const hq = extractWikiField(content, ['headquarters','location','hq_location']);
    let foundedYear = null;
    if (founded) { const m = String(founded).match(/(\d{4})/); if (m) foundedYear = parseInt(m[1]); }
    return { title: sum.title, extract: sum.extract?.slice(0,400)||null, founded_year: foundedYear, employee_count: employees, headquarters: hq ? String(hq).replace(/\[\[|\]\]|\{\{|\}\}/g,'').split('|')[0].trim().slice(0,60) : null, wikipedia_exists: true, page_url: sum.content_urls?.desktop?.page||null };
  } catch(e) { return null; }
}

function extractWikiField(wikitext, keys) {
  for (const key of keys) {
    const r = new RegExp(`\\|\\s*${key}\\s*=\\s*([^\\n|}{]+)`,'i');
    const m = wikitext.match(r);
    if (m && m[1].trim()) return m[1].trim();
  }
  return null;
}

async function fetchOpenCorporates(name, env) {
  // Check KV cache first (24h TTL for OpenCorporates — saves free tier quota)
  const ocKey = `oc:${name.toLowerCase().replace(/[^a-z0-9]/g,'')}`;
  if (env.KV_STORE) {
    const cached = await env.KV_STORE.get(ocKey, { type: 'json' });
    if (cached) return cached;
  }
  try {
    const searches = [
      `https://api.opencorporates.com/v0.4/companies/search?q=${encodeURIComponent(name)}&jurisdiction_code=in&inactive=false&format=json`,
      `https://api.opencorporates.com/v0.4/companies/search?q=${encodeURIComponent(name)}&format=json&per_page=5`,
    ];
    for (const url of searches) {
      const res = await fetch(url, { headers: { 'User-Agent': 'VerdictNxtGen/4.0 (verditnxtgen.com)' } });
      if (!res.ok) continue;
      const data = await res.json();
      const companies = data?.results?.companies || [];
      if (!companies.length) continue;
      const best = companies.map(c => ({ ...c.company, sim: nameSimilarity(name, c.company?.name||'') })).sort((a,b)=>b.sim-a.sim)[0];
      if (best.sim < 0.3) continue;
      const isActive = (best.current_status||'').toLowerCase();
      const result = { name: best.name, company_number: best.company_number, jurisdiction: best.jurisdiction_code, status: best.current_status||'Unknown', incorporation_date: best.incorporation_date, registered: isActive.includes('active')||isActive.includes('live')||isActive.includes('incorporated'), opencorporates_url: best.opencorporates_url, similarity: best.sim };
      if (env.KV_STORE) await env.KV_STORE.put(ocKey, JSON.stringify(result), { expirationTtl: 86400 });
      return result;
    }
    return null;
  } catch(e) { return null; }
}

async function fetchDomainAge(companyName) {
  const base = companyName.toLowerCase().replace(/\s+(pvt|ltd|limited|private|inc|corp|llc|technologies|solutions|services|india|global|group)\b.*/gi,'').replace(/[^a-z0-9]/g,'').trim();
  const domains = [`${base}.com`,`${base}.in`,`${base}india.com`];
  for (const domain of domains) {
    try {
      const r = await fetch(`https://who-dat.as93.net/${domain}`, { headers: { 'User-Agent': 'VerdictNxtGen/4.0' } });
      if (r.ok) { const d = await r.json(); const created = d?.creation_date||d?.created; if (created) { const age = (Date.now()-new Date(created).getTime())/(1000*60*60*24*365.25); return { domain, domain_age_years: Math.round(age*10)/10, has_ssl: true, source: 'who-dat' }; } }
    } catch(e) {}
    if (domain.endsWith('.com')) {
      try {
        const r = await fetch(`https://rdap.verisign.com/com/v1/domain/${domain}`);
        if (r.ok) { const d = await r.json(); const reg = (d?.events||[]).find(e=>e.eventAction==='registration'); if (reg?.eventDate) { const age=(Date.now()-new Date(reg.eventDate).getTime())/(1000*60*60*24*365.25); return {domain, domain_age_years: Math.round(age*10)/10, has_ssl:true, source:'verisign'}; } }
      } catch(e) {}
    }
  }
  return null;
}

// Replaced NewsAPI (100/day) with GNews (500/day free tier)
async function fetchNews(name, env) {
  // Try GNews first (500 req/day free)
  if (env.GNEWS_API_KEY) {
    try {
      const q = encodeURIComponent(`"${name}" fraud OR scam OR fake`);
      const res = await fetch(`https://gnews.io/api/v4/search?q=${q}&lang=en&max=10&token=${env.GNEWS_API_KEY}`);
      if (res.ok) {
        const data = await res.json();
        const articles = data?.articles || [];
        const now = Date.now();
        let weighted = 0;
        const recent = [];
        articles.forEach(a => {
          const ageMonths = (now - new Date(a.publishedAt).getTime())/(1000*60*60*24*30);
          weighted += ageMonths < 3 ? 2.0 : ageMonths < 12 ? 1.0 : 0.3;
          if (ageMonths < 12) recent.push(a.title);
        });
        return { fraud_mentions: data?.totalArticles||articles.length, fraud_weighted_score: Math.round(weighted*10)/10, recent_fraud_articles: recent.slice(0,3), source: 'gnews' };
      }
    } catch(e) {}
  }

  // Fallback: NewsAPI
  if (env.NEWS_API_KEY) {
    try {
      const q = encodeURIComponent(`"${name}" (fraud OR scam OR fake OR cheated)`);
      const res = await fetch(`https://newsapi.org/v2/everything?q=${q}&language=en&pageSize=10&sortBy=publishedAt&apiKey=${env.NEWS_API_KEY}`);
      if (res.ok) {
        const data = await res.json();
        const articles = data?.articles || [];
        const now = Date.now();
        let weighted = 0;
        const recent = [];
        articles.forEach(a => {
          const ageMonths = (now - new Date(a.publishedAt).getTime())/(1000*60*60*24*30);
          weighted += ageMonths < 3 ? 2.0 : ageMonths < 12 ? 1.0 : 0.3;
          if (ageMonths < 12) recent.push(a.title);
        });
        return { fraud_mentions: data?.totalResults||0, fraud_weighted_score: Math.round(weighted*10)/10, recent_fraud_articles: recent.slice(0,3), source: 'newsapi' };
      }
    } catch(e) {}
  }

  return null;
}

function nameSimilarity(a, b) {
  const ta = new Set(a.toLowerCase().replace(/[^a-z0-9\s]/g,'').split(/\s+/).filter(w=>w.length>2));
  const tb = new Set(b.toLowerCase().replace(/[^a-z0-9\s]/g,'').split(/\s+/).filter(w=>w.length>2));
  if (!ta.size||!tb.size) return 0;
  let overlap=0; ta.forEach(w=>{if(tb.has(w))overlap++;});
  return overlap/Math.max(ta.size,tb.size);
}

function mergeSignals(cached, wiki, corp, whois, news) {
  const s = {};
  if (cached?.signals) Object.assign(s, cached.signals);
  if (wiki) { s.wikipedia_exists=true; s.wiki_title=wiki.title; if(wiki.founded_year) s.founded_year=wiki.founded_year; if(wiki.employee_count) s.linkedin_employees=wiki.employee_count; if(wiki.headquarters) s.headquarters=wiki.headquarters; if(wiki.extract) s.description=wiki.extract; if(wiki.page_url) s.wiki_url=wiki.page_url; } else { s.wikipedia_exists=s.wikipedia_exists||false; }
  if (corp) { s.mca=corp.registered?'Active':(corp.status||'Inactive'); s.company_number=corp.company_number; s.jurisdiction=corp.jurisdiction; s.incorporation_date=corp.incorporation_date; s.opencorporates_url=corp.opencorporates_url; if(!s.founded_year&&corp.incorporation_date){const m=corp.incorporation_date.match(/(\d{4})/);if(m)s.founded_year=parseInt(m[1]);} } else if(!s.mca){s.mca='Not verified';}
  if (whois) { s.domain=whois.domain; s.domain_age_years=whois.domain_age_years; s.has_ssl=whois.has_ssl; }
  if (news) { s.news_fraud_mentions=news.fraud_mentions; s.news_fraud_weighted=news.fraud_weighted_score; s.news_recent_titles=news.recent_fraud_articles; s.news_source=news.source; } else { s.news_fraud_mentions=s.news_fraud_mentions||0; }
  return s;
}

function score100(signals) {
  let score=30; const flags=[];
  if(signals.wikipedia_exists){score+=25;}else{score-=5;flags.push('No Wikipedia page — company may be too new or unknown');}
  const mca=(signals.mca||'').toLowerCase();
  if(mca==='active'||mca.includes('active')||mca.includes('live')){score+=20;}
  else if(mca==='not verified'||mca==='unknown'){flags.push('Company registration could not be verified via OpenCorporates');}
  else if(mca&&mca!=='not verified'){score-=10;flags.push(`Company registration status: ${signals.mca}`);}
  const age=signals.domain_age_years;
  if(age!=null){if(age>=15)score+=15;else if(age>=10)score+=13;else if(age>=5)score+=10;else if(age>=2)score+=7;else if(age>=1)score+=4;else if(age<0.5){score-=15;flags.push(`Domain only ${Math.round(age*12)} months old — major red flag`);}}
  const emp=signals.linkedin_employees;
  if(emp){if(emp>=100000)score+=10;else if(emp>=10000)score+=8;else if(emp>=1000)score+=6;else if(emp>=100)score+=4;else if(emp>=10)score+=2;else if(emp<5){score-=5;flags.push('Very few employees detected');}}
  const founded=signals.founded_year;
  if(founded){const y=new Date().getFullYear()-founded;if(y>=30)score+=8;else if(y>=20)score+=7;else if(y>=10)score+=5;else if(y>=5)score+=3;else if(y>=2)score+=1;else if(y<1){score-=10;flags.push('Company founded less than 1 year ago');}}
  const fw=signals.news_fraud_weighted||0; const fr=signals.news_fraud_mentions||0;
  if(fw>10){score-=40;flags.push(`${fr} fraud/scam news articles (weighted score: ${fw} — recent)`)}
  else if(fw>5){score-=25;flags.push(`${fr} fraud-related news articles found`);}
  else if(fw>1){score-=12;flags.push(`${fr} fraud mention(s) in news`);}
  else if(fr>0&&fw<=1){score-=5;}
  const domain=signals.domain||'';
  if(domain&&/-(careers|jobs|hr|apply|recruit|hire|work|pvt|official)/.test(domain)){score-=15;flags.push(`Suspicious domain: ${domain} — mimics a legitimate brand`);}
  return {score:Math.max(0,Math.min(100,Math.round(score))),flags};
}

async function generateSummary(name, signals, score, verdict, flags, env) {
  if(!env.OPENAI_API_KEY) return null;
  try {
    const prompt=`You are a fraud detection assistant for Indian job seekers. Be direct and specific.
Company: "${name}" | Score: ${score}/100 | Verdict: ${verdict.toUpperCase()}
Wikipedia: ${signals.wikipedia_exists?'YES — '+signals.wiki_title:'NOT FOUND'}
Registration: ${signals.mca||'Unknown'} ${signals.jurisdiction?'('+signals.jurisdiction+')':''}
Domain: ${signals.domain||'Unknown'}, age: ${signals.domain_age_years!=null?signals.domain_age_years+' years':'Unknown'}
Founded: ${signals.founded_year||'Unknown'} | Employees: ${signals.linkedin_employees?signals.linkedin_employees.toLocaleString():'Unknown'}
Fraud news: ${signals.news_fraud_mentions||0} articles (weighted: ${signals.news_fraud_weighted||0})
Red flags: ${flags.length?flags.join('; '):'None'}
Write 2-3 sentences for a job seeker who received an interview call. Be specific to this company. End with one clear action.`;
    const res=await fetch('https://api.openai.com/v1/chat/completions',{method:'POST',headers:{'Authorization':`Bearer ${env.OPENAI_API_KEY}`,'Content-Type':'application/json'},body:JSON.stringify({model:'gpt-4o-mini',messages:[{role:'user',content:prompt}],max_tokens:200,temperature:0.3})});
    const data=await res.json();
    return data?.choices?.[0]?.message?.content?.trim()||null;
  } catch(e){return null;}
}

function buildFallbackSummary(name, verdict) {
  if(verdict==='verified') return `${name} appears to be a legitimate company. Verify the recruiter's email matches the official domain and never pay any advance fee.`;
  if(verdict==='fraud') return `Multiple high-risk signals for "${name}". Do not share documents, do not pay any fee. Report at cybercrime.gov.in.`;
  return `Some risk signals found for "${name}". Verify on MCA portal (mca.gov.in) before proceeding. Never pay any advance fee.`;
}

async function saveToGitHub(name, result, env) {
  if(!env.VERDITNXTGEN_TOKEN||!env.GITHUB_REPO) return;
  try {
    const slug=name.toLowerCase().replace(/[^a-z0-9]+/g,'-').replace(/^-|-$/g,'');
    const url=`https://api.github.com/repos/${env.GITHUB_REPO}/contents/data/companies.json`;
    const headers={'Authorization':`Bearer ${env.VERDITNXTGEN_TOKEN}`,'Accept':'application/vnd.github+json','X-GitHub-Api-Version':'2022-11-28'};
    const existing=await fetch(url,{headers});
    if(!existing.ok) return;
    const meta=await existing.json();
    let companies=[];
    try{companies=JSON.parse(atob(meta.content.replace(/\n/g,'')));}catch(e){}
    const entry={name,slug,score:result.score,verdict:result.verdict,signals:result.signals,flags:result.flags,updated:result.updated};
    const idx=companies.findIndex(c=>c.slug===slug);
    if(idx>=0)companies[idx]=entry;else companies.push(entry);
    if(companies.length>500)companies=companies.slice(-500);
    const content=btoa(unescape(encodeURIComponent(JSON.stringify(companies,null,2))));
    await fetch(url,{method:'PUT',headers:{...headers,'Content-Type':'application/json'},body:JSON.stringify({message:`cache: ${name} (${result.score}/100)`,content,sha:meta.sha})});
  } catch(e){}
}

function json(data, status=200) {
  return new Response(JSON.stringify(data,null,2),{status,headers:CORS_OPEN});
}
