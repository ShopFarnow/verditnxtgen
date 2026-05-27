/**
 * worker.js — VerdictNxtGen Cloudflare Worker
 *
 * Deploy this at: workers.dev (free tier)
 * Set as environment variables in Cloudflare dashboard:
 *   OPENAI_API_KEY
 *   PINECONE_API_KEY
 *   PINECONE_HOST
 *   GITHUB_TOKEN
 *   GITHUB_REPO  (e.g. ShopFarnow/verditnxtgen)
 *
 * Endpoints:
 *   GET  /check?q=Company+Name   → returns verdict JSON
 *   POST /queue                  → adds unknown company to database
 */

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Content-Type': 'application/json',
};

// ── Main router ───────────────────────────────────────────
export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: CORS });
    }

    if (url.pathname === '/check') {
      return handleCheck(url.searchParams.get('q'), env);
    }

    if (url.pathname === '/queue' && request.method === 'POST') {
      const body = await request.json();
      return handleQueue(body.name, env);
    }

    return new Response(JSON.stringify({ error: 'Not found' }), {
      status: 404, headers: CORS
    });
  }
};

// ── /check — look up company, return verdict ──────────────
async function handleCheck(query, env) {
  if (!query || query.trim().length < 2) {
    return json({ error: 'Query too short' }, 400);
  }

  const q = query.trim();

  // 1. Fetch live companies.json from GitHub Pages
  const dbRes = await fetch(
    `https://raw.githubusercontent.com/${env.GITHUB_REPO}/main/data/companies.json`,
    { cf: { cacheTtl: 300 } } // cache 5 mins
  );
  const companies = await dbRes.json();

  // 2. Try exact / partial match first (fast, free)
  const lower = q.toLowerCase();
  const exactMatch = companies.find(c =>
    c.name.toLowerCase().includes(lower) ||
    lower.includes(c.name.toLowerCase().split(' ')[0].toLowerCase())
  );

  if (exactMatch) {
    return json({
      source: 'database',
      found: true,
      ...exactMatch
    });
  }

  // 3. No match — use OpenAI + Pinecone RAG for semantic search
  const ragResult = await ragSearch(q, env);
  if (ragResult) {
    return json({
      source: 'rag',
      found: true,
      ...ragResult
    });
  }

  // 4. Totally unknown — queue for nightly crawl, return pending
  await queueNewCompany(q, env);

  return json({
    source: 'queued',
    found: false,
    name: q,
    score: null,
    verdict: 'pending',
    message: 'This company has been queued for verification. Check back in 24 hours for a full verdict.',
    flags: [],
    signals: {}
  });
}

// ── RAG search via Pinecone ───────────────────────────────
async function ragSearch(query, env) {
  try {
    // Get embedding from OpenAI
    const embRes = await fetch('https://api.openai.com/v1/embeddings', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${env.OPENAI_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        input: query,
        model: 'text-embedding-3-small'
      })
    });
    const embData = await embRes.json();
    const vector = embData?.data?.[0]?.embedding;
    if (!vector) return null;

    // Query Pinecone
    const pinRes = await fetch(`${env.PINECONE_HOST}/query`, {
      method: 'POST',
      headers: {
        'Api-Key': env.PINECONE_API_KEY,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        vector,
        topK: 1,
        includeMetadata: true,
        namespace: 'companies'
      })
    });
    const pinData = await pinRes.json();
    const match = pinData?.matches?.[0];

    // Only return if similarity score is high enough
    if (!match || match.score < 0.82) return null;

    return {
      name:    match.metadata.name,
      score:   match.metadata.score,
      verdict: match.metadata.verdict,
      slug:    match.metadata.slug,
      flags:   match.metadata.flags ? match.metadata.flags.split(' | ') : [],
      signals: {},
      similarity: Math.round(match.score * 100)
    };
  } catch (e) {
    return null;
  }
}

// ── Queue unknown company into GitHub via API ─────────────
async function queueNewCompany(name, env) {
  try {
    // Read current queue file from GitHub
    const queueUrl = `https://api.github.com/repos/${env.GITHUB_REPO}/contents/data/queue.json`;
    const headers = {
      'Authorization': `Bearer ${env.VERDITNXTGEN_TOKEN}`,
      'Accept': 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
    };

    let queue = [];
    let sha = null;

    const existing = await fetch(queueUrl, { headers });
    if (existing.ok) {
      const data = await existing.json();
      sha = data.sha;
      queue = JSON.parse(atob(data.content.replace(/\n/g, '')));
    }

    // Don't add duplicates
    const alreadyQueued = queue.some(
      item => item.name.toLowerCase() === name.toLowerCase()
    );
    if (alreadyQueued) return;

    // Add to queue
    queue.push({
      name,
      slug: slugify(name),
      queued_at: new Date().toISOString(),
      status: 'pending'
    });

    // Write back to GitHub
    const body = {
      message: `queue: add "${name}" for verification`,
      content: btoa(JSON.stringify(queue, null, 2)),
    };
    if (sha) body.sha = sha;

    await fetch(queueUrl, {
      method: 'PUT',
      headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
  } catch(e) {
    console.error('Queue error:', e.message);
  }
}

// ── /queue endpoint (manual) ──────────────────────────────
async function handleQueue(name, env) {
  if (!name) return json({ error: 'No name provided' }, 400);
  await queueNewCompany(name, env);
  return json({ success: true, message: `"${name}" queued for verification` });
}

// ── Helpers ───────────────────────────────────────────────
function slugify(name) {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: CORS });
}
