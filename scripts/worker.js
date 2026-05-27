/**
 * worker.js — VerdictNxtGen Cloudflare Worker (Enhanced Logging & Fallbacks)
 *
 * Environment variables:
 *   OPENAI_API_KEY, PINECONE_API_KEY, PINECONE_HOST,
 *   VERDITNXTGEN_TOKEN, GITHUB_REPO,
 *   RAPIDAPI_KEY (required), LIX_API_KEY (optional)
 *
 * Endpoints:
 *   GET /check?q=CompanyName
 *   POST /queue
 */

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Content-Type': 'application/json',
};

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
    if (url.pathname === '/check') return handleCheck(url.searchParams.get('q'), env);
    if (url.pathname === '/queue' && request.method === 'POST') {
      const body = await request.json();
      return handleQueue(body.name, env);
    }
    return new Response(JSON.stringify({ error: 'Not found' }), { status: 404, headers: CORS });
  }
};

// --------------------------------------------------------------
// 1. RDAP / Domain Age (free, multiple fallbacks)
// --------------------------------------------------------------
async function getDomainAgeFromRDAP(companyName) {
  // Convert company name to domain
  let domain = companyName.toLowerCase()
    .replace(/[^a-z0-9.-]/g, '')
    .replace(/\.(com|org|net|in)$/, '') + '.com';
  
  const apis = [
    `https://who-dat.as93.net/${domain}`,                     // Primary RDAP proxy
    `https://rdap.verisign.com/com/v1/domain/${domain}`,       // Verisign RDAP (only .com)
    `https://domain-age-api.vercel.app/api/age?domain=${domain}` // Alternative simple API
  ];

  for (const url of apis) {
    try {
      const response = await fetch(url, { cf: { cacheTtl: 60 } });
      if (!response.ok) continue;
      const data = await response.json();
      // Different APIs return different fields
      let created = data?.creation_date || data?.created || data?.creationDate || data?.events?.find(e => e.eventAction === 'registration')?.eventDate;
      if (!created && data?.result?.creation_date) created = data.result.creation_date;
      if (!created && data?.age) return data.age; // direct age from alternative API
      if (created) {
        const ageMs = Date.now() - new Date(created).getTime();
        const ageYears = ageMs / (1000 * 60 * 60 * 24 * 365.25);
        return Math.round(ageYears * 10) / 10;
      }
    } catch (err) {
      console.error(`RDAP attempt failed for ${url}:`, err.message);
    }
  }
  console.error(`All RDAP attempts failed for ${companyName}`);
  return null;
}

// --------------------------------------------------------------
// 2. Company Intelligence (RapidAPI)
// --------------------------------------------------------------
async function getCompanyIntelligence(domain, env) {
  if (!env.RAPIDAPI_KEY) {
    console.warn('RAPIDAPI_KEY not set');
    return null;
  }
  try {
    const url = `https://company-intelligence.p.rapidapi.com/company-info?domain=${domain}`;
    const response = await fetch(url, {
      headers: {
        'x-rapidapi-key': env.RAPIDAPI_KEY,
        'x-rapidapi-host': 'company-intelligence.p.rapidapi.com',
        'Content-Type': 'application/json'
      }
    });
    if (!response.ok) {
      console.error(`RapidAPI returned ${response.status}`);
      return null;
    }
    const data = await response.json();
    console.log('RapidAPI response:', JSON.stringify(data).substring(0, 500));
    // Map fields (common patterns)
    return {
      employee_count: data?.employeeCount || data?.employees || data?.size,
      linkedin_url: data?.linkedinUrl || data?.linkedin || data?.social?.linkedin,
      company_name: data?.name,
      funding: data?.funding,
      technologies: data?.technologies,
      contact_email: data?.email,
      description: data?.description
    };
  } catch (error) {
    console.error('Company Intelligence error:', error.message);
    return null;
  }
}

// --------------------------------------------------------------
// 3. Lix API (LinkedIn enrichment)
// --------------------------------------------------------------
async function getLixCompanyData(linkedinUrl, env) {
  if (!env.LIX_API_KEY || !linkedinUrl) return null;
  try {
    const url = `https://api.lix-it.com/v1/organisations/by-linkedin?linkedin_url=${encodeURIComponent(linkedinUrl)}`;
    const response = await fetch(url, { headers: { 'Authorization': env.LIX_API_KEY } });
    if (!response.ok) return null;
    const data = await response.json();
    const org = data?.liOrganisation;
    return org ? {
      linkedin_employees: org.liEmployeeCount,
      company_size: org.size,
      industry: org.industry,
      headquarters: org.headquarters,
      followers: org.followers,
      description: org.description
    } : null;
  } catch (err) {
    console.error('Lix error:', err.message);
    return null;
  }
}

// --------------------------------------------------------------
// 4. Try to get LinkedIn URL via company name (Lix)
// --------------------------------------------------------------
async function getLinkedInUrlFromLix(companyName, env) {
  if (!env.LIX_API_KEY) return null;
  try {
    const url = `https://api.lix-it.com/v1/organisations/by-name?name=${encodeURIComponent(companyName)}`;
    const response = await fetch(url, { headers: { 'Authorization': env.LIX_API_KEY } });
    if (!response.ok) return null;
    const data = await response.json();
    return data?.liOrganisation?.link || null;
  } catch (err) {
    console.error('Lix name search error:', err.message);
    return null;
  }
}

// --------------------------------------------------------------
// Main enrichment orchestrator (with logging)
// --------------------------------------------------------------
async function enrichCompanyData(companyName, env) {
  const signals = {};
  console.log(`Enriching: ${companyName}`);

  // Domain age (RDAP)
  const domainAge = await getDomainAgeFromRDAP(companyName);
  if (domainAge !== null) {
    signals.domain_age_years = domainAge;
    console.log(`  ✓ domain_age_years: ${domainAge}`);
  } else {
    console.warn(`  ✗ domain_age_years: failed`);
  }

  // Company Intelligence (RapidAPI)
  const domain = companyName.toLowerCase().replace(/[^a-z0-9.-]/g, '') + '.com';
  const intelligence = await getCompanyIntelligence(domain, env);
  if (intelligence) {
    signals.employee_count = intelligence.employee_count;
    signals.technologies = intelligence.technologies;
    signals.funding = intelligence.funding;
    signals.contact_email = intelligence.contact_email;
    signals.linkedin_url = intelligence.linkedin_url;
    console.log(`  ✓ employee_count: ${intelligence.employee_count}`);
    if (intelligence.linkedin_url) console.log(`  ✓ linkedin_url found via RapidAPI`);
  } else {
    console.warn(`  ✗ Company Intelligence failed`);
  }

  // LinkedIn data (Lix)
  let linkedinUrl = signals.linkedin_url;
  if (!linkedinUrl && env.LIX_API_KEY) {
    linkedinUrl = await getLinkedInUrlFromLix(companyName, env);
    if (linkedinUrl) {
      signals.linkedin_url = linkedinUrl;
      console.log(`  ✓ linkedin_url found via Lix name search`);
    }
  }
  if (linkedinUrl) {
    const lixData = await getLixCompanyData(linkedinUrl, env);
    if (lixData) {
      Object.assign(signals, lixData);
      console.log(`  ✓ linkedin_employees: ${lixData.linkedin_employees}`);
    } else {
      console.warn(`  ✗ Lix enrichment failed for ${linkedinUrl}`);
    }
  } else {
    console.warn(`  ✗ No LinkedIn URL found`);
  }

  return signals;
}

// --------------------------------------------------------------
// RAG search (unchanged, but with logging)
// --------------------------------------------------------------
async function ragSearch(query, env) {
  try {
    const embRes = await fetch('https://api.openai.com/v1/embeddings', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${env.OPENAI_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ input: query, model: 'text-embedding-3-small' })
    });
    const embData = await embRes.json();
    const vector = embData?.data?.[0]?.embedding;
    if (!vector) return null;
    const pinRes = await fetch(`${env.PINECONE_HOST}/query`, {
      method: 'POST',
      headers: { 'Api-Key': env.PINECONE_API_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({ vector, topK: 1, includeMetadata: true, namespace: 'companies' })
    });
    const pinData = await pinRes.json();
    const match = pinData?.matches?.[0];
    if (!match || match.score < 0.82) return null;
    return {
      name: match.metadata.name,
      score: match.metadata.score,
      verdict: match.metadata.verdict,
      slug: match.metadata.slug,
      flags: match.metadata.flags ? match.metadata.flags.split(' | ') : [],
      similarity: Math.round(match.score * 100)
    };
  } catch (e) {
    console.error('RAG error:', e.message);
    return null;
  }
}

// --------------------------------------------------------------
// Queue helper (unchanged)
// --------------------------------------------------------------
async function queueNewCompany(name, env, signals = null) {
  try {
    const queueUrl = `https://api.github.com/repos/${env.GITHUB_REPO}/contents/data/queue.json`;
    const headers = {
      'Authorization': `Bearer ${env.VERDITNXTGEN_TOKEN}`,
      'Accept': 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
    };
    let queue = [], sha = null;
    const existing = await fetch(queueUrl, { headers });
    if (existing.ok) {
      const data = await existing.json();
      sha = data.sha;
      queue = JSON.parse(atob(data.content.replace(/\n/g, '')));
    }
    if (queue.some(item => item.name.toLowerCase() === name.toLowerCase())) return;
    const newItem = { name, slug: slugify(name), queued_at: new Date().toISOString(), status: 'pending' };
    if (signals && Object.keys(signals).length) newItem.signals = signals;
    queue.push(newItem);
    const body = { message: `queue: add "${name}"`, content: btoa(JSON.stringify(queue, null, 2)) };
    if (sha) body.sha = sha;
    await fetch(queueUrl, { method: 'PUT', headers: { ...headers, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  } catch(e) {
    console.error('Queue error:', e.message);
  }
}

// --------------------------------------------------------------
// /check endpoint
// --------------------------------------------------------------
async function handleCheck(query, env) {
  if (!query || query.trim().length < 2) return json({ error: 'Query too short' }, 400);
  const q = query.trim();

  // Fetch existing companies from GitHub
  let companies = [];
  try {
    const dbRes = await fetch(`https://raw.githubusercontent.com/${env.GITHUB_REPO}/main/data/companies.json`, { cf: { cacheTtl: 300 } });
    if (dbRes.ok) {
      const text = await dbRes.text();
      if (text.trim()) companies = JSON.parse(text);
    }
  } catch (err) { console.error('Fetch companies.json error:', err.message); }

  // Exact / partial match
  const lower = q.toLowerCase();
  const exactMatch = companies.find(c => c.name.toLowerCase().includes(lower) || lower.includes(c.name.toLowerCase().split(' ')[0]));
  if (exactMatch) return json({ source: 'database', found: true, ...exactMatch });

  // RAG search
  let ragResult = null;
  if (env.PINECONE_HOST && env.PINECONE_API_KEY && env.OPENAI_API_KEY) ragResult = await ragSearch(q, env);
  if (ragResult) return json({ source: 'rag', found: true, ...ragResult });

  // Enrich unknown company
  const enrichedSignals = await enrichCompanyData(q, env);
  await queueNewCompany(q, env, enrichedSignals);

  return json({
    source: 'queued',
    found: false,
    name: q,
    score: null,
    verdict: 'pending',
    message: 'Queued for verification (enrichment attempted)',
    flags: [],
    signals: enrichedSignals   // <-- will now show what data we collected
  });
}

async function handleQueue(name, env) {
  if (!name) return json({ error: 'No name provided' }, 400);
  await queueNewCompany(name, env);
  return json({ success: true, message: `"${name}" queued` });
}

function slugify(name) {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: CORS });
}
