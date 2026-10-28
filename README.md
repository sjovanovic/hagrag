![Logo](./docs/img/hagrag.jpeg)

# HagRag

**Hypertext-Aware GraphRAG** — crawl a website into a typed semantic graph, then retrieve structured context for an LLM using natural language.

Most RAG systems treat a website as a bag of documents. hagrag does the opposite: it treats every hyperlink as a semantic relation. The anchor text becomes an edge label, the page content becomes the node payload, and retrieval is a local graph search — so the LLM receives not just relevant text but the relationships between pieces of it.

All on-device: one Node.js process, one SQLite file, [ternlight](https://www.npmjs.com/package/@ternlight/base) WASM embeddings. No external APIs, no Python, no GPU.

---

## Install

```bash
npm install hagrag
```

---

## Quick start

### CLI

```bash
# Crawl a site
hagrag crawl https://docs.example.com --db ./site.db

# Query it
hagrag query ./site.db "How do I deploy to production?"

# Or both in one step
hagrag run https://docs.example.com --prompt "How do I deploy to production?"
```

### Library

```js
import { crawl, query } from 'hagrag';

const db = await crawl('https://docs.example.com', './site.db');

const context = query(db, 'How do I deploy to production?');
// Pass context to your LLM as part of the system prompt
```

---

## How it works

```
Seed URL → BFS crawl → parse HTML → anchor text becomes edge labels
         → embed content with ternlight → store in SQLite → PageRank

User prompt → embed → vector search → beam-search graph expansion
           → verbalized triples → LLM context
```

Context the LLM receives preserves the site's link structure:

```
[Getting Started] --"Read the deployment guide"--> [Deployment](https://…)
Deploy your app by running docker compose up…

---

[Getting Started] --"Read the deployment guide"--> [Deployment] --"Configure your environment"--> [Configuration](https://…)
Set DATABASE_URL and SECRET_KEY in your .env file…
```

---

## Key features

- **Multiple seed URLs** — crawl several sections into one shared graph
- **Path filter** — restrict crawling to seed paths or any explicit URL list
- **Pluggable adapter** — replace HTML fetching and/or parsing (headless browser, local files, custom extractors)
- **MCP server** — zero-dependency stdio server for Claude Desktop, Cursor, and other MCP clients
- **`list` command** — inspect crawled URLs sorted by PageRank, depth, or URL

---

## `crawl(seedUrls, dbPath, options)`

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `limit` | number | `500` | Max pages to crawl |
| `depth` | number | `5` | Max BFS depth |
| `concurrency` | number | `5` | Parallel requests |
| `ignoreRobots` | boolean | `false` | Skip robots.txt |
| `pathFilter` | `false` \| `true` \| `string[]` | `false` | `true` = seed paths; array = explicit paths |
| `adapter` | object | `cheerioAdapter` | Custom fetch/parse adapter |

## `query(db, prompt, options)`

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `seedCount` | number | `5` | Vector seed nodes |
| `beamWidth` | number | `3` | Beam search width per hop |
| `maxHops` | number | `2` | Graph expansion depth |
| `contextBudget` | number | `8000` | Max characters returned |

---

## Page adapters

Three levels of customisation — implement whichever you need:

```js
import { cheerioAdapter } from 'hagrag';

// Full control: fetch + parse in one method
const adapter = {
  async parsePage(url) {
    return { title, content, links };  // or null to skip
  },
};

// Override only fetching (e.g. Playwright for JS-rendered pages)
const adapter = {
  async fetch(url) { return { html }; },
  parse: cheerioAdapter.parse,
};

// Override only parsing
const adapter = {
  parse(html, baseUrl) { return { title, content, links }; },
};

const db = await crawl(seeds, './site.db', { adapter });
```

`links` items are `{ href, anchorText }` — `href` may be relative or absolute.

---

## MCP server

```json
{
  "mcpServers": {
    "hagrag": {
      "command": "node",
      "args": ["/path/to/hagrag/bin/hagrag-mcp.js"]
    }
  }
}
```

Tools: `crawl`, `query`, `crawl_query`.

---

## CLI reference

```
hagrag crawl <url...>     Crawl seed URLs into a SQLite graph
hagrag query <db> <prompt> Query a graph database
hagrag run <url...>       Crawl + query in one step  (--prompt required)
hagrag list <db>          List all crawled URLs
```

---

→ **[Full documentation](./docs/USAGE.md)**
