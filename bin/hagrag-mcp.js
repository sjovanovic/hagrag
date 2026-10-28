#!/usr/bin/env node
/**
 * hagrag MCP server — stdio transport, zero extra dependencies.
 *
 * Tools exposed:
 *   crawl        — crawl a URL into a SQLite knowledge graph
 *   query        — query an existing knowledge graph
 *   crawl_query  — crawl + query in one shot
 */
import { crawl, openDb, query } from '../index.js';

// ── JSON-RPC helpers ─────────────────────────────────────────────────────────

function send(obj) {
  process.stdout.write(JSON.stringify(obj) + '\n');
}

function ok(id, result) {
  send({ jsonrpc: '2.0', id, result });
}

function err(id, code, message) {
  send({ jsonrpc: '2.0', id, error: { code, message } });
}

// ── Tool definitions ─────────────────────────────────────────────────────────

const TOOLS = [
  {
    name: 'crawl',
    description: 'Crawl a website from a seed URL and build a semantic knowledge graph stored in a local SQLite file.',
    inputSchema: {
      type: 'object',
      required: ['urls', 'db_path'],
      properties: {
        urls:          { type: 'array', items: { type: 'string' }, description: 'One or more seed URLs to crawl' },
        db_path:       { type: 'string',  description: 'Path to the SQLite file to create or overwrite' },
        limit:         { type: 'integer', description: 'Max pages to crawl (default 500)' },
        depth:         { type: 'integer', description: 'Max BFS depth from seed (default 5)' },
        concurrency:   { type: 'integer', description: 'Parallel HTTP requests (default 5)' },
        ignore_robots: { type: 'boolean', description: 'Ignore robots.txt (default false)' },
        path_filter:   { type: ['boolean', 'array'], items: { type: 'string' }, description: 'true = restrict to seed paths; string array = restrict to these specific URL paths' },
      },
    },
  },
  {
    name: 'query',
    description: 'Query an existing hagrag knowledge graph with a natural-language prompt. Returns verbalized relationship paths for use as LLM context.',
    inputSchema: {
      type: 'object',
      required: ['db_path', 'prompt'],
      properties: {
        db_path:        { type: 'string',  description: 'Path to an existing hagrag SQLite file' },
        prompt:         { type: 'string',  description: 'Natural-language query' },
        seed_count:     { type: 'integer', description: 'Vector seed nodes (default 5)' },
        beam_width:     { type: 'integer', description: 'Beam search width per hop (default 3)' },
        max_hops:       { type: 'integer', description: 'Graph expansion depth (default 2)' },
        context_budget: { type: 'integer', description: 'Max characters returned (default 8000)' },
      },
    },
  },
  {
    name: 'crawl_query',
    description: 'Crawl a website and immediately query it in one step. The graph is held in memory unless db_path is provided.',
    inputSchema: {
      type: 'object',
      required: ['urls', 'prompt'],
      properties: {
        urls:           { type: 'array', items: { type: 'string' }, description: 'One or more seed URLs to crawl' },
        prompt:         { type: 'string',  description: 'Natural-language query' },
        db_path:        { type: 'string',  description: 'Optional: persist the graph to this SQLite path' },
        limit:          { type: 'integer', description: 'Max pages to crawl (default 500)' },
        depth:          { type: 'integer', description: 'Max BFS depth from seed (default 5)' },
        concurrency:    { type: 'integer', description: 'Parallel HTTP requests (default 5)' },
        ignore_robots:  { type: 'boolean', description: 'Ignore robots.txt (default false)' },
        path_filter:    { type: ['boolean', 'array'], items: { type: 'string' }, description: 'true = restrict to seed paths; string array = restrict to these specific URL paths' },
        seed_count:     { type: 'integer', description: 'Vector seed nodes (default 5)' },
        beam_width:     { type: 'integer', description: 'Beam search width per hop (default 3)' },
        max_hops:       { type: 'integer', description: 'Graph expansion depth (default 2)' },
        context_budget: { type: 'integer', description: 'Max characters returned (default 8000)' },
      },
    },
  },
];

// ── Tool handlers ────────────────────────────────────────────────────────────

async function handleCrawl(args) {
  const db = await crawl(args.urls, args.db_path, {
    limit:        args.limit         ?? 500,
    depth:        args.depth         ?? 5,
    concurrency:  args.concurrency   ?? 5,
    ignoreRobots: args.ignore_robots ?? false,
    pathFilter:   args.path_filter   ?? false,
  });

  const { nodes, edges } = db.prepare(
    'SELECT (SELECT COUNT(*) FROM nodes) AS nodes, (SELECT COUNT(*) FROM edges) AS edges'
  ).get();
  const top = db.prepare('SELECT url, pagerank FROM nodes ORDER BY pagerank DESC LIMIT 5').all();
  db.close();

  const summary = [
    `Crawled ${nodes} pages, ${edges} edges.`,
    `Graph saved to: ${args.db_path}`,
    '',
    'Top pages by PageRank:',
    ...top.map(p => `  ${p.pagerank.toFixed(5)}  ${p.url}`),
  ].join('\n');

  return summary;
}

function handleQuery(args) {
  const db = openDb(args.db_path);
  const context = query(db, args.prompt, {
    seedCount:     args.seed_count     ?? 5,
    beamWidth:     args.beam_width     ?? 3,
    maxHops:       args.max_hops       ?? 2,
    contextBudget: args.context_budget ?? 8000,
  });
  db.close();

  if (!context) throw new Error('No results found. Is the database populated?');
  return context;
}

async function handleCrawlQuery(args) {
  const dbPath = args.db_path ?? ':memory:';
  const db = await crawl(args.urls, dbPath, {
    limit:        args.limit         ?? 500,
    depth:        args.depth         ?? 5,
    concurrency:  args.concurrency   ?? 5,
    ignoreRobots: args.ignore_robots ?? false,
    pathFilter:   args.path_filter   ?? false,
  });

  const context = query(db, args.prompt, {
    seedCount:     args.seed_count     ?? 5,
    beamWidth:     args.beam_width     ?? 3,
    maxHops:       args.max_hops       ?? 2,
    contextBudget: args.context_budget ?? 8000,
  });
  db.close();

  if (!context) throw new Error('No results found after crawling.');
  return context;
}

// ── Request dispatcher ───────────────────────────────────────────────────────

async function handle(req) {
  const { id, method, params } = req;

  if (method === 'initialize') {
    return ok(id, {
      protocolVersion: '2024-11-05',
      serverInfo: { name: 'hagrag', version: '0.0.1' },
      capabilities: { tools: {} },
    });
  }

  if (method === 'notifications/initialized') return; // no response needed

  if (method === 'tools/list') {
    return ok(id, { tools: TOOLS });
  }

  if (method === 'tools/call') {
    const { name, arguments: args = {} } = params;
    try {
      let text;
      if      (name === 'crawl')       text = await handleCrawl(args);
      else if (name === 'query')       text = handleQuery(args);
      else if (name === 'crawl_query') text = await handleCrawlQuery(args);
      else return err(id, -32601, `Unknown tool: ${name}`);

      ok(id, { content: [{ type: 'text', text }] });
    } catch (e) {
      ok(id, { content: [{ type: 'text', text: `Error: ${e.message}` }], isError: true });
    }
    return;
  }

  err(id, -32601, `Method not found: ${method}`);
}

// ── Stdio transport ──────────────────────────────────────────────────────────

let buf = '';

process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => {
  buf += chunk;
  const lines = buf.split('\n');
  buf = lines.pop(); // keep incomplete last line
  for (const line of lines) {
    if (!line.trim()) continue;
    let req;
    try { req = JSON.parse(line); } catch { continue; }
    handle(req).catch(e => process.stderr.write(`hagrag-mcp error: ${e.message}\n`));
  }
});

process.stdin.on('end', () => process.exit(0));
process.stderr.write('hagrag MCP server ready\n');
