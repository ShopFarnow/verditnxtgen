/**
 * sync-embeddings.js — VerdictNxtGen RAG Sync
 * Converts each company to a vector and upserts into Pinecone.
 * Runs nightly via GitHub Actions after score.js completes.
 */

const fs   = require('fs');
const path = require('path');
const https = require('https');

const OPENAI_API_KEY   = process.env.OPENAI_API_KEY;
const PINECONE_API_KEY = process.env.PINECONE_API_KEY;
const PINECONE_HOST    = process.env.PINECONE_HOST; // e.g. https://verditnxtgen-xxxx.svc.pinecone.io

// ── POST helper ───────────────────────────────────────────
function postJSON(url, body, headers) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const urlObj = new URL(url);
    const options = {
      hostname: urlObj.hostname,
      path: urlObj.pathname,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(data),
        ...headers
      }
    };
    const req = https.request(options, res => {
      let out = '';
      res.on('data', c => out += c);
      res.on('end', () => {
        try { resolve(JSON.parse(out)); }
        catch(e) { resolve(null); }
      });
    });
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

// ── Get OpenAI embedding for a text ──────────────────────
async function getEmbedding(text) {
  const result = await postJSON(
    'https://api.openai.com/v1/embeddings',
    { input: text, model: 'text-embedding-3-small' },
    { 'Authorization': `Bearer ${OPENAI_API_KEY}` }
  );
  return result?.data?.[0]?.embedding ?? null;
}

// ── Upsert a batch into Pinecone ─────────────────────────
async function upsertToPinecone(vectors) {
  if (!PINECONE_HOST) {
    console.log('⚠  PINECONE_HOST not set — skipping upsert');
    return;
  }
  return postJSON(
    `${PINECONE_HOST}/vectors/upsert`,
    { vectors, namespace: 'companies' },
    { 'Api-Key': PINECONE_API_KEY }
  );
}

// ── Main ─────────────────────────────────────────────────
async function main() {
  const companies = JSON.parse(
    fs.readFileSync(path.join(__dirname, '../data/companies.json'), 'utf8')
  );

  console.log(`🤖 Syncing ${companies.length} companies to Pinecone...`);

  const BATCH_SIZE = 10;
  for (let i = 0; i < companies.length; i += BATCH_SIZE) {
    const batch = companies.slice(i, i + BATCH_SIZE);
    const vectors = [];

    for (const co of batch) {
      // Build a rich text description for embedding
      const text = [
        `Company: ${co.name}`,
        `Verdict: ${co.verdict}`,
        `Trust score: ${co.score}/100`,
        `MCA status: ${co.signals?.mca}`,
        co.flags?.length ? `Red flags: ${co.flags.join(', ')}` : 'No red flags',
      ].join('. ');

      const embedding = await getEmbedding(text);
      if (!embedding) { console.warn(`  ⚠ No embedding for ${co.name}`); continue; }

      vectors.push({
        id: co.slug,
        values: embedding,
        metadata: {
          name:    co.name,
          score:   co.score,
          verdict: co.verdict,
          slug:    co.slug,
          flags:   (co.flags || []).join(' | '),
        }
      });
      console.log(`  ✓ ${co.name} (${co.score}/100)`);
    }

    if (vectors.length > 0) {
      await upsertToPinecone(vectors);
      console.log(`  📤 Upserted batch of ${vectors.length}`);
    }
  }

  console.log(`✅ Pinecone sync complete`);
}

main().catch(console.error);
