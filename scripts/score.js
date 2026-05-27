/**
 * score.js — VerdictNxtGen Trust Scoring Engine (Fixed)
 * Merges crawled raw data WITH existing signals from companies.json
 */

const fs   = require('fs');
const path = require('path');

const RAW_DIR      = path.join(__dirname, '../data/raw');
const COMPANIES_FILE = path.join(__dirname, '../data/companies.json');
const OUTPUT_FILE  = path.join(__dirname, '../data/companies.json');

function scoreCompany(existing, raw) {
  let score = 0;
  const flags = [];
  const signals = { ...existing.signals };

  // Merge fresh crawl data into signals
  if (raw.whois?.domain_age_years > 0) {
    signals.domain_age_years = raw.whois.domain_age_years;
  }
  if (raw.news?.fraud_mentions !== undefined) {
    signals.news_fraud_mentions = raw.news.fraud_mentions;
  }

  // ── MCA ──────────────────────────────────────────────────
  if (signals.mca === 'Active') {
    score += 30;
  } else if (!signals.mca || signals.mca === 'Not found') {
    score -= 15;
    flags.push('Not found in MCA21 company registry');
  }

  // ── Domain age ───────────────────────────────────────────
  const ageYears = signals.domain_age_years ?? 0;
  if (ageYears >= 2)       score += 20;
  else if (ageYears >= 1)  score += 10;
  else if (ageYears < 0.5 && ageYears > 0) {
    score -= 10;
    flags.push(`Domain registered only ${Math.round(ageYears * 12)} months ago`);
  }

  // ── Reviews ──────────────────────────────────────────────
  if ((signals.review_count ?? 0) >= 10) score += 15;

  // ── LinkedIn ─────────────────────────────────────────────
  const employees = signals.linkedin_employees ?? 0;
  if (employees >= 10)    score += 15;
  else if (employees === 0) {
    score -= 5;
    flags.push('No employees found on LinkedIn');
  }

  // ── GST ──────────────────────────────────────────────────
  if (signals.gst === 'Active') score += 10;

  // ── News fraud ───────────────────────────────────────────
  const fraudMentions = signals.news_fraud_mentions ?? 0;
  if (fraudMentions > 0) {
    score -= 30;
    flags.push(`Found ${fraudMentions} fraud/scam news article(s)`);
  }

  // ── Clamp 0–100 ──────────────────────────────────────────
  score = Math.max(0, Math.min(100, score));

  const verdict = score >= 80 ? 'verified'
                : score >= 50 ? 'caution'
                :               'fraud';

  return {
    ...existing,
    score,
    verdict,
    flags,
    signals,
    updated: new Date().toISOString().split('T')[0],
  };
}

function main() {
  // 🔥 SAFE READ: companies.json – fallback to [] if empty or invalid
  let companies = [];
  try {
    const raw = fs.readFileSync(COMPANIES_FILE, 'utf8');
    if (raw.trim()) {
      companies = JSON.parse(raw);
      if (!Array.isArray(companies)) {
        console.warn('⚠️ companies.json is not an array – resetting to []');
        companies = [];
      }
    } else {
      console.warn('⚠️ companies.json is empty – starting with []');
      companies = [];
    }
  } catch (err) {
    console.error('❌ Failed to parse companies.json:', err.message);
    console.warn('⚠️ Starting with empty company list []');
    companies = [];
  }

  // If no companies, just write empty array back and exit
  if (companies.length === 0) {
    fs.writeFileSync(OUTPUT_FILE, JSON.stringify([], null, 2));
    console.log('✅ No companies to score – wrote empty companies.json');
    return;
  }

  const results = companies.map(company => {
    const rawPath = path.join(RAW_DIR, `${company.slug}.json`);
    let raw = {};
    if (fs.existsSync(rawPath)) {
      try {
        raw = JSON.parse(fs.readFileSync(rawPath, 'utf8'));
      } catch (err) {
        console.error(`Failed to parse raw data for ${company.slug}:`, err.message);
      }
    }
    return scoreCompany(company, raw);
  });

  results.sort((a, b) => b.score - a.score);
  fs.writeFileSync(OUTPUT_FILE, JSON.stringify(results, null, 2));

  const counts = { verified: 0, caution: 0, fraud: 0 };
  results.forEach(r => counts[r.verdict]++);
  console.log(`✅  Scored ${results.length} companies → data/companies.json`);
  console.log(`   ✓ Verified: ${counts.verified}  ⚠ Caution: ${counts.caution}  ✗ Fraud: ${counts.fraud}`);
}

main();
