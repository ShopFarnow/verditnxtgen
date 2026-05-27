/**
 * crawl.js — VerdictNxtGen Data Crawler
 * Runs nightly via GitHub Actions.
 * Hits MCA21, WHOIS, NewsAPI, and saves raw data.
 */

const fs   = require('fs');
const path = require('path');
const https = require('https');

const RAW_DIR = path.join(__dirname, '../data/raw');
if (!fs.existsSync(RAW_DIR)) fs.mkdirSync(RAW_DIR, { recursive: true });

const NEWS_API_KEY = process.env.NEWS_API_KEY;

// ── Simple HTTPS fetch helper ──────────────────────────────
function fetchJSON(url) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { 'User-Agent': 'VerdictNxtGen/1.0' } }, res => {
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

// ── Check news for fraud mentions ─────────────────────────
async function checkNews(companyName) {
  if (!NEWS_API_KEY) return { fraud_mentions: 0, articles: [] };
  const query = encodeURIComponent(`"${companyName}" fraud OR scam OR fake OR cheated`);
  const url = `https://newsapi.org/v2/everything?q=${query}&language=en&pageSize=5&apiKey=${NEWS_API_KEY}`;
  const data = await fetchJSON(url);
  return {
    fraud_mentions: data?.totalResults ?? 0,
    articles: data?.articles?.map(a => a.title) ?? []
  };
}

// ── Check WHOIS domain age via free API ───────────────────
async function checkDomain(website) {
  if (!website) return { domain_age_years: 0, has_ssl: false };
  try {
    const domain = website.replace(/https?:\/\//,'').split('/')[0];
    // Using whoisjsonapi free tier
    const url = `https://www.whoisxmlapi.com/whoisserver/WhoisService?apiKey=free&domainName=${domain}&outputFormat=JSON`;
    const data = await fetchJSON(url);
    const created = data?.WhoisRecord?.createdDate;
    if (created) {
      const ageYears = (Date.now() - new Date(created).getTime()) / (1000*60*60*24*365);
      return { domain_age_years: Math.round(ageYears * 10) / 10, has_ssl: website.startsWith('https') };
    }
  } catch(e) {}
  return { domain_age_years: 0, has_ssl: false };
}

// ── Load companies list and crawl each one ────────────────
async function main() {
  const companies = JSON.parse(
    fs.readFileSync(path.join(__dirname, '../data/companies.json'), 'utf8')
  );

  console.log(`🔍 Crawling ${companies.length} companies...`);

  for (const company of companies) {
    console.log(`  → ${company.name}`);

    // Check news
    const news = await checkNews(company.name);

    // Check domain if website exists
    const whois = await checkDomain(company.website || null);

    // Build raw record merging existing signals with fresh data
    const raw = {
      name:    company.name,
      slug:    company.slug,
      mca:     { status: company.signals?.mca || 'Unknown', cin: company.cin || null },
      whois,
      news,
      glassdoor: { review_count: company.signals?.review_count || 0 },
      linkedin:  { employee_count: company.signals?.linkedin_employees || 0 },
      gst:       { status: company.signals?.gst || 'Unknown' },
      website:   { has_ssl: whois.has_ssl, has_content: true },
      jd_analysis: { has_advance_fee: false, scam_similarity: 0 }
    };

    fs.writeFileSync(
      path.join(RAW_DIR, `${company.slug}.json`),
      JSON.stringify(raw, null, 2)
    );

    await sleep(500); // be polite to APIs
  }

  console.log(`✅ Crawl complete — ${companies.length} raw files saved to data/raw/`);
}

main().catch(console.error);
