// populate-pinecone.js
import { Pinecone } from '@pinecone-database/pinecone';
import OpenAI from 'openai';
import 'dotenv/config';

// Load from .env file
const pc = new Pinecone({ apiKey: process.env.PINECONE_API_KEY });
const index = pc.index('verditnxtgen'); // use your exact index name
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

async function upsertCompany(company) {
  // Generate embedding for the company name
  const embedding = await openai.embeddings.create({
    model: 'text-embedding-3-small',
    input: company.name,
  });
  const vector = embedding.data[0].embedding;

  // Upsert into Pinecone under namespace "companies"
  await index.namespace('companies').upsert([{
    id: company.slug,
    values: vector,
    metadata: {
      name: company.name,
      score: company.score,
      verdict: company.verdict,
      slug: company.slug,
      flags: company.flags?.join(' | ') || '',
    },
  }]);

  console.log(`✅ Upserted: ${company.name}`);
}

// The companies you want to make searchable (should match your companies.json)
const companies = [
  { name: 'Shopify', score: 92, verdict: 'trustworthy', slug: 'shopify', flags: ['ecommerce', 'public'] },
  { name: 'Tesla', score: 75, verdict: 'cautious', slug: 'tesla', flags: ['automotive', 'elon-musk'] },
];

async function main() {
  for (const company of companies) {
    await upsertCompany(company);
  }
  console.log('🎉 All companies upserted to Pinecone!');
}

main().catch(console.error);
