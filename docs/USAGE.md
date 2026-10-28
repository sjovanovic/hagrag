# hagrag Usage Guide


![Logo](./img/hagrag.jpeg)

**Hypertext-Aware GraphRAG** — crawl a website into a semantic graph, then query it with natural language to retrieve structured context for an LLM.

---

## Installation

```bash
npm install hagrag
```

---

## Quick Start

### CLI

```bash
# Crawl a site and save the graph
hagrag crawl https://docs.example.com --db ./site.db

# Crawl multiple seed URLs into one graph
hagrag crawl https://docs.example.com/api https://docs.example.com/guides --db ./site.db

# Query the saved graph
hagrag query ./site.db "How do I configure the database connection?"

# Crawl and query in one step (ephemeral)
hagrag run https://docs.example.com --prompt "How do I configure the database connection?"
```

### Library

```js
import { crawl, query } from 'hagrag';

// Phase 1: crawl a site into a local SQLite database
const db = await crawl('https://docs.example.com', './site.db');

// Phase 2: query for LLM context
const context = query(db, 'How do I configure the database connection?');

console.log(context);
// [Getting Started] --"Read the deployment guide"--> [Deployment](…)
// Configure the database by setting DATABASE_URL in your environment…
```

Pass `context` as part of your LLM system prompt. The retrieved text preserves the site's link structure as human-readable relationship paths.

---

## CLI

Install globally to use `hagrag` from anywhere:

```bash
npm install -g hagrag
```

Or run directly from the project:

```bash
node bin/hagrag.js <command>
```

### `hagrag crawl <url...>`

Crawl one or more seed URLs and save the knowledge graph to a SQLite file.

```bash
hagrag crawl https://docs.example.com --db ./site.db --limit 200 --depth 4

# Multiple seed URLs — merged into one graph
hagrag crawl https://docs.example.com/api https://docs.example.com/guides --db ./site.db

# Restrict to each seed's own sub-path
hagrag crawl https://docs.example.com/api https://docs.example.com/guides \
  --db ./site.db --path-filter

# Restrict to explicit paths (comma-separated), regardless of seed URLs
hagrag crawl https://docs.example.com --db ./site.db \
  --path-filter "https://docs.example.com/api,https://docs.example.com/guides"
```

| Flag | Default | Description |
|------|---------|-------------|
| `--db <path>` | `./hagrag.db` | Output SQLite file |
| `-l, --limit <n>` | `500` | Max pages to crawl |
| `-d, --depth <n>` | `5` | Max BFS depth from seed |
| `-c, --concurrency <n>` | `5` | Parallel HTTP requests |
| `--ignore-robots` | — | Skip robots.txt |
| `--path-filter` | — | Restrict crawl to seed URL paths |
| `--path-filter <u1,u2>` | — | Restrict crawl to these specific URL paths (comma-separated) |

### `hagrag query <db> <prompt>`

Query an existing graph database. Writes the retrieved context to stdout (diagnostics go to stderr), so it pipes cleanly into other tools.

```bash
hagrag query ./site.db "How do I deploy to production?"

# Pipe context into an LLM CLI
hagrag query ./site.db "What are the IFC entity types?" | llm -s "Answer using only the context below"
```

| Flag | Default | Description |
|------|---------|-------------|
| `-s, --seed-count <n>` | `5` | Vector seed nodes |
| `-w, --beam-width <n>` | `3` | Beam search width per hop |
| `-H, --max-hops <n>` | `2` | Graph expansion depth |
| `-b, --budget <n>` | `8000` | Max context characters |

### `hagrag run <url> <prompt>`

Crawl and query in one step. The database is ephemeral (in-memory) unless `--db` is given.

```bash
hagrag run https://docs.example.com --prompt "What is this site about?"

# Multiple seeds, persist DB for follow-up queries
hagrag run https://docs.example.com/api https://docs.example.com/guides \
  --prompt "How do I authenticate?" --db ./site.db
```

Accepts all flags from both `crawl` and `query`.

---

## API

### `crawl(seedUrl, dbPath, options?)`

Crawls a website starting from `seedUrl` using BFS, embeds each page's content, and stores the graph in a SQLite file at `dbPath`.

Returns the open `better-sqlite3` database instance.

```js
// Single seed URL
const db = await crawl('https://docs.example.com', './site.db');

// Multiple seed URLs — crawled into one shared graph
const db = await crawl([
  'https://docs.example.com/api',
  'https://docs.example.com/guides',
], './site.db', {
  limit:       500,
  depth:       5,
  concurrency: 5,
  ignoreRobots: false,
  pathFilter:  true,  // restrict each seed to its own sub-path
});
```

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `limit` | number | `500` | Maximum number of pages to crawl |
| `depth` | number | `5` | Maximum BFS depth from the seed URL |
| `concurrency` | number | `5` | Number of parallel HTTP requests |
| `ignoreRobots` | boolean | `false` | Skip robots.txt checking |
| `pathFilter` | `false` \| `true` \| `string[]` | `false` | URL path restriction (see below) |
| `adapter` | object | `cheerioAdapter` | Page adapter for custom fetching and parsing (see below) |

**`pathFilter` values:**

| Value | Behaviour |
|-------|-----------|
| `false` | No restriction — follow any URL within the seed origins |
| `true` | Restrict to each seed URL's own sub-path |
| `string[]` | Restrict to these specific URL paths, regardless of seed URLs |

```js
// Restrict to seed paths
crawl(seeds, './site.db', { pathFilter: true });

// Restrict to explicit paths
crawl(seeds, './site.db', {
  pathFilter: ['https://docs.example.com/api', 'https://docs.example.com/guides'],
});
```

After crawling, PageRank is computed over the graph and stored on every node.

---

### `query(db, prompt, options?)`

Embeds `prompt`, finds semantically similar seed nodes, expands through the graph via beam search, and returns a context string with verbalized relationship paths.

```js
const context = query(db, 'How do I deploy to production?', {
  seedCount:     5,     // initial vector search results
  beamWidth:     3,     // candidates kept per hop
  maxHops:       2,     // graph expansion depth
  contextBudget: 8000,  // max characters in returned context
});
```

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `seedCount` | number | `5` | Number of nodes selected by vector similarity |
| `beamWidth` | number | `3` | Candidates retained at each graph hop |
| `maxHops` | number | `2` | How many hops to expand from each seed |
| `contextBudget` | number | `8000` | Maximum characters returned |

---

### `openDb(dbPath)`

Opens an existing database without crawling. Use this to re-query a previously crawled site.

```js
import { openDb, query } from 'hagrag';

const db = openDb('./site.db');
const context = query(db, 'What entities does IFC define?');
db.close();
```

---

### `computePageRank(db, options?)`

Re-runs PageRank over the graph. Called automatically at the end of `crawl()`, but exposed if you want to recompute after manual graph edits.

```js
import { computePageRank } from 'hagrag';

computePageRank(db, { damping: 0.85, iterations: 20 });
```

---

### `cheerioAdapter`

The built-in page adapter, exported for extension. Implements `parse(html, baseUrl)` using [cheerio](https://cheerio.js.org).

```js
import { cheerioAdapter } from 'hagrag';
```

---

## Page adapters

The `adapter` option lets you replace or extend how pages are fetched and parsed. Three interfaces are supported — implement whichever fits your use case.

### `parsePage(url)` — full control

Handles both fetching and parsing in one call. Return `null` to skip the page.

```js
const adapter = {
  async parsePage(url) {
    // fetch + parse yourself
    return {
      title: '...',
      content: '...',
      links: [{ href: '/relative', anchorText: 'Link text' }],
    };
    // return null to skip this URL
  },
};
```

`links[].href` may be relative or absolute — the crawler resolves and filters them.

### `fetch(url)` + `parse(html, baseUrl)` — split concerns

Override only fetching (e.g. headless browser, authenticated sessions, local cache) while reusing cheerio for parsing, or vice versa.

```js
import { cheerioAdapter } from 'hagrag';

// Custom fetch, reuse cheerio parsing
const adapter = {
  async fetch(url) {
    const html = await myBrowser.getPageSource(url);
    return { html };   // return null to skip
  },
  parse: cheerioAdapter.parse,
};

// Built-in HTTP fetch, custom parsing
const adapter = {
  parse(html, baseUrl) {
    return { title, content, links };
  },
};
```

### Resolution order

`parsePage` → `fetch` + `parse` → built-in HTTP fetch + `parse`

### Common patterns

```js
// Playwright for JavaScript-rendered pages
import { chromium } from 'playwright';
const browser = await chromium.launch();
const page = await browser.newPage();

const adapter = {
  async parsePage(url) {
    await page.goto(url, { waitUntil: 'networkidle' });
    const html = await page.content();
    return cheerioAdapter.parse(html, url);
  },
};

// Local filesystem
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const adapter = {
  async parsePage(url) {
    const path = resolve('./mirror', new URL(url).pathname.slice(1));
    const html = await readFile(path, 'utf8').catch(() => null);
    if (!html) return null;
    return cheerioAdapter.parse(html, url);
  },
};
```

---

## Context format

The retrieved context preserves the site's link structure. Seed nodes are shown as plain entries; nodes reached via graph expansion are prefixed with their relationship path:

```
[Getting Started](https://docs.example.com/start)
Welcome to the application. This guide will walk you through…

---

[Getting Started] --"Read the deployment guide"--> [Deployment](https://docs.example.com/deploy)
Deploy your app by running docker compose up…

---

[Getting Started] --"Read the deployment guide"--> [Deployment] --"Configure your environment"--> [Configuration](https://docs.example.com/config)
Set DATABASE_URL and SECRET_KEY in your .env file…
```

Each `--"label"-->` is the anchor text of the hyperlink, which is a human-authored statement of how the two pages relate.

---

## Test script

Run against a local server with default options:

```bash
npm test
```

All parameters are configurable via environment variables:

```bash
HAGRAG_URL=http://localhost:61482/ \
HAGRAG_QUERY="What are the IFC entity types?" \
HAGRAG_LIMIT=200 \
HAGRAG_DEPTH=4 \
npm test
```

| Variable | Default | Description |
|----------|---------|-------------|
| `HAGRAG_URL` | `http://localhost:61482/` | Seed URL |
| `HAGRAG_DB` | `./test/crawl-test.db` | SQLite output path |
| `HAGRAG_QUERY` | `What is this site about?` | Query prompt |
| `HAGRAG_LIMIT` | `50` | Max pages to crawl |
| `HAGRAG_DEPTH` | `3` | Max BFS depth |
| `HAGRAG_CONCURRENCY` | `5` | Parallel requests |
| `HAGRAG_SEED_COUNT` | `5` | Vector seed nodes |
| `HAGRAG_BEAM_WIDTH` | `3` | Beam search width |
| `HAGRAG_MAX_HOPS` | `2` | Graph expansion depth |
| `HAGRAG_CONTEXT_BUDGET` | `8000` | Max context characters |

---

## Database schema

The SQLite database is a plain file you can inspect with any SQLite tool.

```sql
-- One row per crawled page
SELECT url, title, pagerank, depth FROM nodes ORDER BY pagerank DESC;

-- One row per internal hyperlink with its anchor text
SELECT from_id, to_id, anchor_text, weight FROM edges;
```

**`nodes`**

| Column | Type | Description |
|--------|------|-------------|
| `id` | TEXT (PK) | SHA-1 hash of the URL (first 16 hex chars) |
| `url` | TEXT | Canonical page URL |
| `title` | TEXT | Page `<title>` or first `<h1>` |
| `content` | TEXT | Extracted main text |
| `embedding` | BLOB | 384-dim float32 vector from ternlight |
| `pagerank` | REAL | PageRank score |
| `depth` | INTEGER | BFS depth from seed |

**`edges`**

| Column | Type | Description |
|--------|------|-------------|
| `from_id` | TEXT | Source node id |
| `to_id` | TEXT | Target node id |
| `anchor_text` | TEXT | The hyperlink's anchor text — the semantic edge label |
| `weight` | REAL | Edge weight (default 1.0) |

---

## Performance

| Operation | Typical throughput |
|-----------|--------------------|
| Crawl | ~100 pages/min at concurrency 5 |
| Embed | ~5 ms/page (ternlight base, CPU) |
| Query | < 500 ms over ~5 000 nodes |
| Vector search | Brute-force, sub-ms for ≤ 5 000 nodes |

Embeddings are computed by [`@ternlight/base`](https://www.npmjs.com/package/@ternlight/base) — a 7 MB WASM bundle that runs entirely on CPU with no API calls or model downloads.

---

## MCP Server

hagrag ships a zero-dependency [Model Context Protocol](https://modelcontextprotocol.io) server. It uses stdio transport and speaks JSON-RPC 2.0, so any MCP-compatible client (Claude Desktop, Cursor, etc.) can use it without configuration beyond a path.

### Setup

Add to your MCP client config (e.g. `claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "hagrag": {
      "command": "node",
      "args": ["/absolute/path/to/hagrag/bin/hagrag-mcp.js"]
    }
  }
}
```

Or if installed globally:

```json
{
  "mcpServers": {
    "hagrag": {
      "command": "hagrag-mcp"
    }
  }
}
```

### Tools

| Tool | Description |
|------|-------------|
| `crawl` | Crawl a website and save the knowledge graph to a SQLite file |
| `query` | Query an existing graph database with a natural-language prompt |
| `crawl_query` | Crawl and query in one step (graph is ephemeral unless `db_path` given) |

#### `crawl`

| Argument | Type | Required | Default | Description |
|----------|------|----------|---------|-------------|
| `urls` | string[] | ✓ | — | One or more seed URLs |
| `db_path` | string | ✓ | — | Output SQLite path |
| `limit` | integer | | `500` | Max pages to crawl |
| `depth` | integer | | `5` | Max BFS depth |
| `concurrency` | integer | | `5` | Parallel requests |
| `ignore_robots` | boolean | | `false` | Ignore robots.txt |
| `path_filter` | `false` \| `true` \| `string[]` | | `false` | `true` = restrict to seed paths; string array = restrict to these specific URL paths |

#### `query`

| Argument | Type | Required | Default | Description |
|----------|------|----------|---------|-------------|
| `db_path` | string | ✓ | — | Path to existing hagrag DB |
| `prompt` | string | ✓ | — | Natural-language query |
| `seed_count` | integer | | `5` | Vector seed nodes |
| `beam_width` | integer | | `3` | Beam width per hop |
| `max_hops` | integer | | `2` | Graph expansion depth |
| `context_budget` | integer | | `8000` | Max characters returned |

#### `crawl_query`

Accepts all arguments from both `crawl` and `query`. `db_path` is optional — omit it to use an in-memory graph.

---

## Architecture

```
Seed URL → BFS crawl → parse HTML → extract links (anchor text as edge labels)
         → extract main content → embed with ternlight
         → store nodes + edges in SQLite → compute PageRank

User prompt → embed → brute-force kNN (384-dim cosine similarity)
           → beam search over graph → assemble verbalized triples → LLM
```

See [`docs/SPECS.md`](./SPECS.md) for the full technical specification.
