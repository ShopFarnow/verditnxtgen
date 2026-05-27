/**
 * crawl.js — VerdictNxtGen Data Crawler (Dynamic Version)
 *
 * 1. Crawls existing companies in companies.json (refresh scores)
 * 2. Picks up NEW companies from data/queue.json (user-submitted)
 * 3. Saves raw data to data/raw/[slug].json
 *
 * Runs nightly via GitHub Actions — zero manual work.
 */

const fs    = require('fs');
const path  = require('path');
const https = require('https');

const RAW_DIR        = path.join(__dirname, '../data/raw');
const COMPANIES_FILE = path.join(__dirname, '../data/companies.json');
const QUEUE_FILE     = path.join(__dirname, '../data/queue.json');

const NEWS_API_KEY = process.env.NEWS_API_KEY;

if (!fs.existsSync(RAW_DIR)) fs.mkdirSync(RAW_DIR, { recursive: true });

// ── HTTPS fetch helper ────────────────────────────────────
function fetchJSON(url) {
  return new Promise((resolve) => {
    https.get(url, { headers: { 'User-Agent': 'VerdictNxtGen-Crawler/1.0' } }, res => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch(e) { resolve(null); }
      });
    }).on('error', () => resolve(null));
  });
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

function slugify(name) {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

// ── Check NewsAPI for fraud mentions ─────────────────────
async function checkNews(companyName) {
  if (!NEWS_API_KEY) {
    console.log('    ℹ No NEWS_API_KEY — skipping news check');
    return { fraud_mentions: 0, articles: [] };
  }
  const query = encodeURIComponent(`"${companyName}" fraud OR scam OR fake OR cheated`);
  const url = `https://newsapi.org/v2/everything?q=${query}&language=en&pageSize=5&apiKey=${NEWS_API_KEY}`;
  const data = await fetchJSON(url);
  return {
    fraud_mentions: data?.totalResults ?? 0,
    articles: (data?.articles ?? []).slice(0, 3).map(a => a.title)
  };
}

// ── Check WHOIS for domain age ────────────────────────────
async function checkDomain(website) {
  if (!website) return { domain_age_years: 0, has_ssl: false, has_content: false };
  try {
    const domain = website.replace(/https?:\/\//, '').split('/')[0];
    const url = `https://rdap.org/domain/${domain}`;
    const data = await fetchJSON(url);
    const events = data?.events ?? [];
    const reg = events.find(e => e.eventAction === 'registration');
    if (reg?.eventDate) {
      const ageYears = (Date.now() - new Date(reg.eventDate).getTime()) / (1000 * 60 * 60 * 24 * 365);
      return {
        domain_age_years: Math.round(ageYears * 10) / 10,
        has_ssl: website.startsWith('https'),
        has_content: true
      };
    }
  } catch(e) {}
  return { domain_age_years: 0, has_ssl: website?.startsWith('https') ?? false, has_content: false };
}

// ── Crawl one company ─────────────────────────────────────
async function crawlCompany(company) {
  console.log(`  → Crawling: ${company.name}`);

  const [news, whois] = await Promise.all([
    checkNews(company.name),
    checkDomain(company.website || null)
  ]);

  const raw = {
    name:    company.name,
    slug:    company.slug,
    mca:     { status: company.signals?.mca || 'Unknown', cin: company.cin || null },
    whois,
    news,
    glassdoor: { review_count: company.signals?.review_count || 0 },
    linkedin:  { employee_count: company.signals?.linkedin_employees || 0 },
    gst:       { status: company.signals?.gst || 'Unknown' },
    website:   whois,
    jd_analysis: { has_advance_fee: false, scam_similarity: 0 }
  };

  fs.writeFileSync(
    path.join(RAW_DIR, `${company.slug}.json`),
    JSON.stringify(raw, null, 2)
  );

  return raw;
}

// ── Process queued companies (user-submitted unknowns) ────
function processQueue(companies) {
  if (!fs.existsSync(QUEUE_FILE)) return companies;

  const queue = JSON.parse(fs.readFileSync(QUEUE_FILE, 'utf8'));
  const pending = queue.filter(item => item.status === 'pending');

  if (pending.length === 0) {
    console.log('  📭 No new companies in queue');
    return companies;
  }

  console.log(`  📬 Found ${pending.length} new companies in queue`);

  const existingSlugs = new Set(companies.map(c => c.slug));

  for (const item of pending) {
    if (existingSlugs.has(item.slug)) {
      console.log(`    ⤷ Already exists: ${item.name}`);
      item.status = 'duplicate';
      continue;
    }

    // Add new company with minimal data — score.js will calculate
    companies.push({
      name:    item.name,
      slug:    item.slug,
      website: '',
      score:   0,
      verdict: 'pending',
      flags:   [],
      signals: {
        mca: 'Unknown',
        domain_age_years: 0,
        review_count: 0,
        linkedin_employees: 0,
        gst: 'Unknown',
        news_fraud_mentions: 0
      },
      updated: new Date().toISOString().split('T')[0]
    });

    item.status = 'processed';
    console.log(`    ✓ Added to database: ${item.name}`);
  }

  // Save updated queue back
  fs.writeFileSync(QUEUE_FILE, JSON.stringify(queue, null, 2));

  // Save updated companies list
  fs.writeFileSync(COMPANIES_FILE, JSON.stringify(companies, null, 2));

  return companies;
}

// ── Main ──────────────────────────────────────────────────
async function main() {
  let companies = JSON.parse(fs.readFileSync(COMPANIES_FILE, 'utf8'));

  // Step 1: Process any user-submitted companies from queue
  console.log('\n📬 Processing queue...');
  companies = processQueue(companies);

  // Step 2: Crawl all companies
  console.log(`\n🔍 Crawling ${companies.length} companies...`);

  for (const company of companies) {
    await crawlCompany(company);
    await sleep(600); // polite delay between requests
  }

  console.log(`\n✅ Crawl complete — ${companies.length} companies processed`);
}

main().catch(err => {
  console.error('❌ Crawl failed:', err);
  process.exit(1);
});
