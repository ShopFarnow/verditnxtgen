/**
 * score.js — VerdictNxtGen Trust Scoring Engine
 *
 * Reads raw crawled data from data/raw/*.json
 * Outputs scored records to data/companies.json
 *
 * Run by GitHub Actions nightly — zero manual work needed.
 */

const fs   = require('fs');
const path = require('path');

const RAW_DIR      = path.join(__dirname, '../data/raw');
const OUTPUT_FILE  = path.join(__dirname, '../data/companies.json');

// ─────────────────────────────────────────────────────────────
//  SCORING WEIGHTS  (total: ~100 positive, -60 negative)
// ─────────────────────────────────────────────────────────────
const WEIGHTS = {
  // POSITIVE signals
  mca_active:           30,   // MCA21 shows Active status
  domain_age_2yr:       20,   // Domain registered > 2 years ago
  domain_age_1yr:       10,   // Domain registered > 1 year ago (partial)
  glassdoor_reviews:    15,   // Has >= 10 reviews on Glassdoor/AmbitionBox
  linkedin_employees:   15,   // LinkedIn shows >= 10 employees
  gst_active:           10,   // GST registration is active
  website_ssl:           5,   // Has valid HTTPS cert
  professional_website:  5,   // Website has real content (not parked)

  // NEGATIVE signals
  news_fraud_mentions: -30,   // News API returns fraud/scam keywords
  advance_fee_pattern: -20,   // JD text asks for money/deposit
  scam_jd_similarity:  -10,   // JD text similar to known scam templates
  mca_not_found:       -15,   // Company not found in MCA at all
  domain_under_6months:-10,   // Domain < 6 months old
  zero_linkedin:        -5,   // LinkedIn shows 0 employees
};

function scoreCompany(raw) {
  let score = 0;
  const flags = [];
  const signals = {};

  // ── MCA check ──────────────────────────────────────────────
  if (raw.mca?.status === 'Active') {
    score += WEIGHTS.mca_active;
    signals.mca = 'Active';
  } else if (!raw.mca || raw.mca?.status === 'Not Found') {
    score += WEIGHTS.mca_not_found;
    flags.push('Not found in MCA21 company registry');
    signals.mca = 'Not found';
  } else {
    signals.mca = raw.mca.status || 'Unknown';
  }

  // ── Domain age ─────────────────────────────────────────────
  const ageYears = raw.whois?.domain_age_years ?? 0;
  signals.domain_age_years = ageYears;
  if (ageYears >= 2) {
    score += WEIGHTS.domain_age_2yr;
  } else if (ageYears >= 1) {
    score += WEIGHTS.domain_age_1yr;
  } else if (ageYears < 0.5) {
    score += WEIGHTS.domain_under_6months;
    flags.push(`Domain registered only ${Math.round(ageYears * 12)} months ago`);
  }

  // ── Glassdoor / AmbitionBox ────────────────────────────────
  const reviewCount = raw.glassdoor?.review_count ?? 0;
  signals.review_count = reviewCount;
  if (reviewCount >= 10) {
    score += WEIGHTS.glassdoor_reviews;
  }

  // ── LinkedIn ───────────────────────────────────────────────
  const employees = raw.linkedin?.employee_count ?? 0;
  signals.linkedin_employees = employees;
  if (employees >= 10) {
    score += WEIGHTS.linkedin_employees;
  } else if (employees === 0) {
    score += WEIGHTS.zero_linkedin;
    flags.push('No employees found on LinkedIn — possible ghost company');
  }

  // ── GST ────────────────────────────────────────────────────
  if (raw.gst?.status === 'Active') {
    score += WEIGHTS.gst_active;
    signals.gst = 'Active';
  } else {
    signals.gst = raw.gst?.status || 'Not found';
  }

  // ── Website SSL + content ──────────────────────────────────
  if (raw.website?.has_ssl)     score += WEIGHTS.website_ssl;
  if (raw.website?.has_content) score += WEIGHTS.professional_website;

  // ── News fraud mentions ────────────────────────────────────
  const fraudMentions = raw.news?.fraud_mentions ?? 0;
  signals.news_fraud_mentions = fraudMentions;
  if (fraudMentions > 0) {
    score += WEIGHTS.news_fraud_mentions;
    flags.push(`Found ${fraudMentions} fraud/scam news article(s)`);
  }

  // ── Advance fee / JD scam patterns ────────────────────────
  if (raw.jd_analysis?.has_advance_fee) {
    score += WEIGHTS.advance_fee_pattern;
    flags.push('Job description asks for registration fee or security deposit');
  }
  if (raw.jd_analysis?.scam_similarity > 0.75) {
    score += WEIGHTS.scam_jd_similarity;
    flags.push('Job description closely matches known scam templates');
  }

  // ── Clamp to 0–100 ────────────────────────────────────────
  score = Math.max(0, Math.min(100, score));

  // ── Verdict ────────────────────────────────────────────────
  const verdict = score >= 80 ? 'verified'
                : score >= 50 ? 'caution'
                :               'fraud';

  return {
    name:       raw.name,
    cin:        raw.mca?.cin ?? null,
    slug:       slugify(raw.name),
    score,
    verdict,
    flags,
    signals,
    updated:    new Date().toISOString().split('T')[0],
  };
}

function slugify(name) {
  return name.toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}

// ─────────────────────────────────────────────────────────────
//  MAIN: read raw files → score → write companies.json
// ─────────────────────────────────────────────────────────────
function main() {
  const rawFiles = fs.readdirSync(RAW_DIR).filter(f => f.endsWith('.json'));
  const results = rawFiles.map(file => {
    const raw = JSON.parse(fs.readFileSync(path.join(RAW_DIR, file), 'utf8'));
    return scoreCompany(raw);
  });

  // Sort: verified first, then caution, then fraud
  results.sort((a, b) => b.score - a.score);

  fs.writeFileSync(OUTPUT_FILE, JSON.stringify(results, null, 2));
  console.log(`✅  Scored ${results.length} companies → data/companies.json`);

  // Print summary
  const counts = { verified: 0, caution: 0, fraud: 0 };
  results.forEach(r => counts[r.verdict]++);
  console.log(`   ✓ Verified: ${counts.verified}  ⚠ Caution: ${counts.caution}  ✗ Fraud: ${counts.fraud}`);
}

main();
