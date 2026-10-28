import { crawl, query } from '../index.js';
import { rm } from 'node:fs/promises';

const SEED_URL = process.env.HAGRAG_URL ?? 'http://localhost:61482/';
const DB_PATH  = process.env.HAGRAG_DB  ?? './test/crawl-test.db';
const QUERY    = process.env.HAGRAG_QUERY ?? 'What is this site about?';

const CRAWL_OPTS = {
  limit:       Number(process.env.HAGRAG_LIMIT ?? 50),
  depth:       Number(process.env.HAGRAG_DEPTH ?? 3),
  concurrency: Number(process.env.HAGRAG_CONCURRENCY ?? 5),
};

const QUERY_OPTS = {
  seedCount:     Number(process.env.HAGRAG_SEED_COUNT ?? 5),
  beamWidth:     Number(process.env.HAGRAG_BEAM_WIDTH ?? 3),
  maxHops:       Number(process.env.HAGRAG_MAX_HOPS ?? 2),
  contextBudget: Number(process.env.HAGRAG_CONTEXT_BUDGET ?? 8000),
};

// Clean up any previous run
try { await rm(DB_PATH); } catch {}

console.log('=== hagrag crawl-and-query test ===');
console.log(`Seed URL : ${SEED_URL}`);
console.log(`DB path  : ${DB_PATH}`);
console.log(`Crawl    : limit=${CRAWL_OPTS.limit} depth=${CRAWL_OPTS.depth} concurrency=${CRAWL_OPTS.concurrency}`);
console.log('');

// ── Phase 1: Crawl ───────────────────────────────────────────────────────────
console.log('--- Phase 1: Crawl ---');
const t0 = performance.now();
const db = await crawl(SEED_URL, DB_PATH, CRAWL_OPTS);
const crawlMs = (performance.now() - t0).toFixed(0);

const { nodes, edges } = db.prepare(`
  SELECT
    (SELECT COUNT(*) FROM nodes) AS nodes,
    (SELECT COUNT(*) FROM edges) AS edges
`).get();

const topPages = db.prepare(
  'SELECT url, pagerank FROM nodes ORDER BY pagerank DESC LIMIT 5'
).all();

console.log(`\nCrawl complete in ${crawlMs} ms`);
console.log(`Nodes: ${nodes}   Edges: ${edges}`);
console.log('\nTop pages by PageRank:');
for (const p of topPages) {
  console.log(`  ${p.pagerank.toFixed(5)}  ${p.url}`);
}

// ── Phase 2: Query ────────────────────────────────────────────────────────────
console.log('\n--- Phase 2: Query ---');
console.log(`Prompt: "${QUERY}"`);
console.log(`Options: seedCount=${QUERY_OPTS.seedCount} beamWidth=${QUERY_OPTS.beamWidth} maxHops=${QUERY_OPTS.maxHops}\n`);

const t1 = performance.now();
const context = query(db, QUERY, QUERY_OPTS);
const queryMs = (performance.now() - t1).toFixed(1);

console.log(`Query complete in ${queryMs} ms`);
console.log(`Context length: ${context.length} chars\n`);
console.log('=== Retrieved context ===');
console.log(context);

db.close();
