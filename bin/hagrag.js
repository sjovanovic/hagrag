#!/usr/bin/env node
import { program } from 'commander';
import { crawl, openDb, query } from '../index.js';

// --path-filter        → true  (filter to seed paths)
// --path-filter u1,u2  → ['u1','u2']  (filter to explicit paths)
// (absent)             → false (no filter)
function parsePathFilter(val) {
  if (val === undefined || val === false) return false;
  if (val === true) return true;
  return val.split(',').map(u => u.trim()).filter(Boolean);
}

program
  .name('hagrag')
  .description('Hypertext-Aware GraphRAG — crawl a website into a semantic graph and query it')
  .version('0.0.1');

// ── crawl ────────────────────────────────────────────────────────────────────

program
  .command('crawl <url...>')
  .description('Crawl one or more seed URLs and save the graph to a SQLite file')
  .option('--db <path>',           'output SQLite file (default: ./hagrag.db)',  './hagrag.db')
  .option('-l, --limit <n>',       'max pages to crawl',                          v => Number(v), 500)
  .option('-d, --depth <n>',       'max BFS depth from seed',                     v => Number(v), 5)
  .option('-c, --concurrency <n>', 'parallel HTTP requests',                      v => Number(v), 5)
  .option('--ignore-robots',       'ignore robots.txt',                           false)
  .option('--path-filter [urls]',  'restrict crawl to seed paths, or to comma-separated URL paths if given')
  .action(async (urls, opts) => {
    console.log(`Crawling ${urls.join(', ')} → ${opts.db}`);
    const database = await crawl(urls, opts.db, {
      limit:        opts.limit,
      depth:        opts.depth,
      concurrency:  opts.concurrency,
      ignoreRobots: opts.ignoreRobots,
      pathFilter:   parsePathFilter(opts.pathFilter),
    });

    const { nodes, edges } = database.prepare(`
      SELECT
        (SELECT COUNT(*) FROM nodes) AS nodes,
        (SELECT COUNT(*) FROM edges) AS edges
    `).get();

    const top = database.prepare(
      'SELECT url, pagerank FROM nodes ORDER BY pagerank DESC LIMIT 5'
    ).all();

    console.log(`\nNodes: ${nodes}   Edges: ${edges}`);
    console.log('\nTop pages by PageRank:');
    for (const p of top) console.log(`  ${p.pagerank.toFixed(5)}  ${p.url}`);

    database.close();
  });

// ── list ─────────────────────────────────────────────────────────────────────

program
  .command('list <db>')
  .description('List all crawled URLs in a graph database')
  .option('--sort <field>', 'sort by: url, pagerank, depth (default: pagerank)', 'pagerank')
  .option('--asc',          'sort ascending (default: descending for pagerank, ascending for others)', false)
  .action((db, opts) => {
    const database = openDb(db);

    const validSorts = { url: 'url', pagerank: 'pagerank', depth: 'depth' };
    const col = validSorts[opts.sort] ?? 'pagerank';
    // pagerank defaults DESC (highest first); url/depth default ASC
    const defaultDir = col === 'pagerank' ? 'DESC' : 'ASC';
    const dir = opts.asc ? 'ASC' : defaultDir;

    const rows = database.prepare(
      `SELECT url, depth, pagerank FROM nodes ORDER BY ${col} ${dir}`
    ).all();
    database.close();

    if (rows.length === 0) {
      console.error('No pages found — is the database populated?');
      process.exit(1);
    }

    for (const r of rows) {
      console.log(`${r.pagerank.toFixed(5)}  d${r.depth}  ${r.url}`);
    }
    console.error(`\n${rows.length} pages`);
  });

// ── query ────────────────────────────────────────────────────────────────────

program
  .command('query <db> <prompt>')
  .description('Query an existing graph database with a natural-language prompt')
  .option('-s, --seed-count <n>',     'vector seed nodes',         v => Number(v), 5)
  .option('-w, --beam-width <n>',     'beam search width per hop', v => Number(v), 3)
  .option('-H, --max-hops <n>',       'graph expansion depth',     v => Number(v), 2)
  .option('-b, --budget <n>',         'max context characters',    v => Number(v), 8000)
  .action((db, prompt, opts) => {
    const database = openDb(db);
    const t0 = performance.now();
    const context = query(database, prompt, {
      seedCount:     opts.seedCount,
      beamWidth:     opts.beamWidth,
      maxHops:       opts.maxHops,
      contextBudget: opts.budget,
    });
    const ms = (performance.now() - t0).toFixed(1);

    database.close();

    if (!context) {
      console.error('No results — is the database crawled?');
      process.exit(1);
    }

    console.error(`Query completed in ${ms} ms\n`); // stderr so stdout is clean context
    process.stdout.write(context);
  });

// ── run (crawl + query in one step) ─────────────────────────────────────────

program
  .command('run <url...>')
  .description('Crawl one or more URLs and immediately query them (ephemeral — no DB saved)')
  .requiredOption('-p, --prompt <text>',  'query prompt (required)')
  .option('--db <path>',              'persist the DB to this path instead of discarding')
  .option('-l, --limit <n>',          'max pages to crawl',                    v => Number(v), 500)
  .option('-d, --depth <n>',          'max BFS depth from seed',               v => Number(v), 5)
  .option('-c, --concurrency <n>',    'parallel HTTP requests',                v => Number(v), 5)
  .option('--ignore-robots',          'ignore robots.txt',                     false)
  .option('--path-filter [urls]',     'restrict crawl to seed paths, or to comma-separated URL paths if given')
  .option('-s, --seed-count <n>',     'vector seed nodes',                     v => Number(v), 5)
  .option('-w, --beam-width <n>',     'beam search width per hop',             v => Number(v), 3)
  .option('-H, --max-hops <n>',       'graph expansion depth',                 v => Number(v), 2)
  .option('-b, --budget <n>',         'max context characters',                v => Number(v), 8000)
  .action(async (urls, opts) => {
    const dbPath = opts.db ?? ':memory:';
    console.error(`Crawling ${urls.join(', ')}…`);

    const database = await crawl(urls, dbPath, {
      limit:        opts.limit,
      depth:        opts.depth,
      concurrency:  opts.concurrency,
      ignoreRobots: opts.ignoreRobots,
      pathFilter:   parsePathFilter(opts.pathFilter),
    });

    const { nodes } = database.prepare('SELECT COUNT(*) AS nodes FROM nodes').get();
    console.error(`Crawled ${nodes} pages. Querying…\n`);

    const t0 = performance.now();
    const context = query(database, opts.prompt, {
      seedCount:     opts.seedCount,
      beamWidth:     opts.beamWidth,
      maxHops:       opts.maxHops,
      contextBudget: opts.budget,
    });
    console.error(`Query completed in ${(performance.now() - t0).toFixed(1)} ms\n`);

    database.close();
    process.stdout.write(context);
  });

program.parse();
