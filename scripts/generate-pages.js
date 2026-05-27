/**
 * generate-pages.js — VerdictNxtGen SEO Page Generator
 *
 * For every scored company, generates a static HTML page at:
 *   /company/[slug].html
 *
 * Each page targets Google searches like:
 *   "is [Company Name] genuine?"
 *   "is [Company Name] a fraud?"
 *   "[Company Name] review job offer"
 *
 * Also rebuilds sitemap.xml so Google crawls new pages daily.
 *
 * Run automatically by GitHub Actions — zero manual work.
 */

const fs   = require('fs');
const path = require('path');

const COMPANIES_FILE = path.join(__dirname, '../data/companies.json');
const COMPANY_DIR    = path.join(__dirname, '../company');
const SITEMAP_FILE   = path.join(__dirname, '../sitemap.xml');
const BASE_URL       = 'https://verditnxtgen.com';

// Ensure output directory exists
if (!fs.existsSync(COMPANY_DIR)) fs.mkdirSync(COMPANY_DIR);

// ─────────────────────────────────────────────────────────────
//  HTML TEMPLATE — one page per company
//  Targets long-tail SEO: "is X genuine", "X job offer fraud"
// ─────────────────────────────────────────────────────────────
function generatePage(company) {
  const verdictText = company.verdict === 'verified' ? 'Verified Genuine'
                    : company.verdict === 'caution'  ? 'Proceed with Caution'
                    :                                  'Likely Fraud — Do Not Proceed';

  const verdictColor = company.verdict === 'verified' ? '#00c896'
                     : company.verdict === 'caution'  ? '#ff7a1a'
                     :                                  '#e8243c';

  const flagsHtml = company.flags.length > 0
    ? `<ul class="flags">${company.flags.map(f => `<li>⚠ ${f}</li>`).join('')}</ul>`
    : `<p class="no-flags">✓ No major red flags detected.</p>`;

  const signalsHtml = Object.entries(company.signals || {})
    .map(([k, v]) => `<tr><td>${k.replace(/_/g,' ')}</td><td><strong>${v}</strong></td></tr>`)
    .join('');

  // JSON-LD structured data for Google rich results
  const jsonLd = JSON.stringify({
    "@context": "https://schema.org",
    "@type": "WebPage",
    "name": `Is ${company.name} Genuine? Trust Verdict`,
    "description": `AI-powered trust score for ${company.name}. Score: ${company.score}/100. Verdict: ${verdictText}.`,
    "url": `${BASE_URL}/company/${company.slug}`,
    "dateModified": company.updated,
    "mainEntity": {
      "@type": "LocalBusiness",
      "name": company.name,
      "description": `Trust score ${company.score}/100 — ${verdictText}`
    }
  });

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Is ${company.name} Genuine? Trust Score ${company.score}/100 — VerdictNxtGen</title>
<meta name="description" content="Is ${company.name} a genuine company? Our AI trust score is ${company.score}/100. Verdict: ${verdictText}. Check MCA status, domain age, employee count, news alerts.">
<meta name="keywords" content="is ${company.name} genuine, ${company.name} fraud, ${company.name} job offer real, ${company.name} scam, ${company.name} company review">
<link rel="canonical" href="${BASE_URL}/company/${company.slug}">
<meta property="og:title" content="Is ${company.name} Genuine? Trust Score: ${company.score}/100">
<meta property="og:description" content="Verdict: ${verdictText}. AI-powered company verification.">
<meta property="og:url" content="${BASE_URL}/company/${company.slug}">
<script type="application/ld+json">${jsonLd}</script>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link href="https://fonts.googleapis.com/css2?family=Syne:wght@700;800&family=DM+Sans:wght@300;400;500&display=swap" rel="stylesheet">
<style>
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: 'DM Sans', sans-serif; background: #f7f6f2; color: #0d0d12; line-height: 1.6; }
  nav { background: rgba(247,246,242,0.9); backdrop-filter: blur(18px); border-bottom: 1px solid rgba(0,0,0,0.08); padding: 0 24px; height: 60px; display: flex; align-items: center; justify-content: space-between; position: sticky; top: 0; z-index: 100; }
  .logo { font-family: 'Syne', sans-serif; font-weight: 800; font-size: 18px; color: #0d0d12; text-decoration: none; }
  .logo span { color: #1a3cff; }
  .container { max-width: 760px; margin: 0 auto; padding: 48px 24px; }
  .breadcrumb { font-size: 13px; color: #8888a0; margin-bottom: 24px; }
  .breadcrumb a { color: #1a3cff; text-decoration: none; }
  h1 { font-family: 'Syne', sans-serif; font-weight: 800; font-size: clamp(24px, 5vw, 40px); letter-spacing: -1px; margin-bottom: 12px; line-height: 1.1; }
  .updated { font-size: 13px; color: #8888a0; margin-bottom: 32px; }
  .score-card { background: #fff; border: 1px solid rgba(0,0,0,0.08); border-radius: 20px; padding: 32px; margin-bottom: 24px; }
  .verdict-large { font-family: 'Syne', sans-serif; font-weight: 800; font-size: 28px; color: ${verdictColor}; margin-bottom: 16px; }
  .score-label { font-size: 14px; color: #8888a0; margin-bottom: 6px; }
  .score-big { font-family: 'Syne', sans-serif; font-weight: 800; font-size: 56px; line-height: 1; color: ${verdictColor}; }
  .score-bar-bg { background: #f0f0f0; border-radius: 8px; height: 12px; margin: 16px 0; overflow: hidden; }
  .score-bar-fill { height: 100%; width: ${company.score}%; background: ${verdictColor}; border-radius: 8px; }
  .signals-table { width: 100%; border-collapse: collapse; font-size: 14px; }
  .signals-table td { padding: 10px 0; border-bottom: 1px solid rgba(0,0,0,0.06); color: #4a4a5a; }
  .signals-table td:first-child { text-transform: capitalize; width: 50%; }
  .signals-table tr:last-child td { border-bottom: none; }
  .flags { margin: 16px 0; padding-left: 0; list-style: none; }
  .flags li { background: #fff5f5; color: #8a0014; padding: 8px 12px; border-radius: 8px; margin-bottom: 6px; font-size: 14px; }
  .no-flags { color: #0a6644; background: #d4f5ea; padding: 8px 12px; border-radius: 8px; font-size: 14px; }
  .back-btn { display: inline-block; margin-top: 32px; background: #1a3cff; color: #fff; text-decoration: none; padding: 12px 24px; border-radius: 10px; font-weight: 500; font-size: 14px; }
  footer { background: #0d0d12; color: rgba(255,255,255,.5); text-align: center; padding: 32px 24px; font-size: 13px; margin-top: 60px; }
  footer a { color: rgba(255,255,255,.7); text-decoration: none; }
</style>
</head>
<body>
<nav>
  <a href="/" class="logo">verdict<span>nxt</span>gen</a>
  <a href="/" style="font-size:13px;color:#4a4a5a;text-decoration:none">← Check another company</a>
</nav>
<div class="container">
  <div class="breadcrumb"><a href="/">Home</a> › <a href="/company/">Companies</a> › ${company.name}</div>

  <h1>Is ${company.name} Genuine?</h1>
  <p class="updated">Last verified: ${company.updated} · Auto-updated daily</p>

  <div class="score-card">
    <div class="verdict-large">${verdictText}</div>
    <div class="score-label">AI Trust Score</div>
    <div class="score-big">${company.score}<span style="font-size:24px;color:#8888a0">/100</span></div>
    <div class="score-bar-bg"><div class="score-bar-fill"></div></div>

    ${flagsHtml}

    <h2 style="font-family:'Syne',sans-serif;font-size:16px;margin:24px 0 12px">Data signals checked</h2>
    <table class="signals-table"><tbody>${signalsHtml}</tbody></table>
  </div>

  <p style="font-size:15px;color:#4a4a5a;line-height:1.8">
    If you received an interview call or offer letter from <strong>${company.name}</strong> and have doubts,
    ${company.verdict === 'verified'
      ? 'this company appears to be legitimate based on our automated checks. Always verify the recruiter\'s official email and do not pay any fee.'
      : company.verdict === 'caution'
      ? 'proceed carefully. Verify the CIN number directly on the <a href="https://www.mca.gov.in/mcafoportal/checkCompanyName.do">MCA portal</a> and never pay a registration fee.'
      : 'do not proceed. Our checks indicate this company has multiple fraud risk signals. Report it at <a href="https://cybercrime.gov.in">cybercrime.gov.in</a>.'}
  </p>

  <a href="/" class="back-btn">→ Check another company</a>
</div>
<footer>
  <a href="/">verditnxtgen.com</a> · Free company verification for Indian job seekers ·
  Data from MCA21, WHOIS, NewsAPI · Updated daily
</footer>
</body>
</html>`;
}

// ─────────────────────────────────────────────────────────────
//  SITEMAP GENERATOR — Google indexes new pages daily
// ─────────────────────────────────────────────────────────────
function generateSitemap(companies) {
  const today = new Date().toISOString().split('T')[0];
  const urls = [
    { loc: BASE_URL,              priority: '1.0', changefreq: 'daily' },
    { loc: `${BASE_URL}/about`,   priority: '0.5', changefreq: 'monthly' },
    { loc: `${BASE_URL}/report`,  priority: '0.5', changefreq: 'monthly' },
    ...companies.map(c => ({
      loc: `${BASE_URL}/company/${c.slug}`,
      priority: c.verdict === 'fraud' ? '0.9' : '0.7',  // fraud pages rank high (people search for them)
      changefreq: 'daily',
      lastmod: c.updated,
    }))
  ];

  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${urls.map(u => `  <url>
    <loc>${u.loc}</loc>
    <lastmod>${u.lastmod || today}</lastmod>
    <changefreq>${u.changefreq}</changefreq>
    <priority>${u.priority}</priority>
  </url>`).join('\n')}
</urlset>`;

  return xml;
}

// ─────────────────────────────────────────────────────────────
//  MAIN
// ─────────────────────────────────────────────────────────────
function main() {
  const companies = JSON.parse(fs.readFileSync(COMPANIES_FILE, 'utf8'));

  let generated = 0;
  companies.forEach(company => {
    const html = generatePage(company);
    const outPath = path.join(COMPANY_DIR, `${company.slug}.html`);
    fs.writeFileSync(outPath, html);
    generated++;
  });
  console.log(`✅  Generated ${generated} SEO company pages → /company/*.html`);

  // Rebuild sitemap
  const sitemap = generateSitemap(companies);
  fs.writeFileSync(SITEMAP_FILE, sitemap);
  console.log(`✅  Rebuilt sitemap.xml with ${companies.length + 3} URLs`);

  // robots.txt
  const robots = `User-agent: *
Allow: /
Sitemap: ${BASE_URL}/sitemap.xml

# Fast-changing pages — recrawl daily
Crawl-delay: 1
`;
  fs.writeFileSync(path.join(__dirname, '../robots.txt'), robots);
  console.log(`✅  Updated robots.txt`);
}

main();
