import pLimit from 'p-limit';
import robotsParser from 'robots-parser';
import { embed } from '@ternlight/base';
import { createHash } from 'node:crypto';
import { openDb } from './db.js';
import { cheerioAdapter } from './adapters/cheerio.js';

function makeId(url) {
  return createHash('sha1').update(url).digest('hex').slice(0, 16);
}

export function computePageRank(db, { damping = 0.85, iterations = 20 } = {}) {
  const nodes = db.prepare('SELECT id FROM nodes').all();
  const N = nodes.length;
  if (N === 0) return;

  const pr = new Map(nodes.map(n => [n.id, 1 / N]));

  const outboundStmt = db.prepare('SELECT to_id, weight FROM edges WHERE from_id = ?');

  for (let iter = 0; iter < iterations; iter++) {
    const newPr = new Map(nodes.map(n => [n.id, (1 - damping) / N]));

    for (const node of nodes) {
      const outbound = outboundStmt.all(node.id);
      const outWeight = outbound.reduce((s, e) => s + e.weight, 0);
      if (outWeight === 0) continue;

      for (const edge of outbound) {
        if (!newPr.has(edge.to_id)) continue;
        newPr.set(edge.to_id, newPr.get(edge.to_id) + damping * pr.get(node.id) * (edge.weight / outWeight));
      }
    }

    for (const [k, v] of newPr) pr.set(k, v);
  }

  const update = db.prepare('UPDATE nodes SET pagerank = ? WHERE id = ?');
  const updateMany = db.transaction(() => {
    for (const [id, score] of pr) update.run(score, id);
  });
  updateMany();
}

export async function crawl(seedUrls, dbPath, {
  limit = 500,
  depth = 5,
  concurrency = 5,
  ignoreRobots = false,
  pathFilter = false,
  adapter = cheerioAdapter,
} = {}) {
  // Accept a single URL string or an array
  const seeds = (Array.isArray(seedUrls) ? seedUrls : [seedUrls]).map(u => u.trim());
  if (seeds.length === 0) throw new Error('At least one seed URL is required');

  const db = openDb(dbPath);

  // Build per-origin robots parsers and allowed-path sets
  const origins = new Set(seeds.map(u => new URL(u).origin));
  // Normalise seed paths for prefix matching:
  // Append '/' so that /seed doesn't accidentally match /seeding.
  // Keep the bare pathname too so the seed page itself always matches.
  const seedPaths = seeds.map(u => {
    const p = new URL(u).pathname;
    return p.endsWith('/') ? p : p + '/';
  });
  const seedPathsBare = seeds.map(u => new URL(u).pathname);

  // Resolve pathFilter to a concrete list of { bare, prefix } pairs:
  //   false        → no filter
  //   true         → filter to seed URL paths
  //   string[]     → filter to the given URLs' paths
  const filterEntries = (() => {
    if (!pathFilter) return null;
    const urls = Array.isArray(pathFilter) ? pathFilter : seeds;
    return urls.map(u => {
      const p = new URL(u).pathname;
      return { bare: p, prefix: p.endsWith('/') ? p : p + '/' };
    });
  })();

  // Fetch robots.txt for each unique origin (best-effort)
  const robotsByOrigin = new Map();
  if (!ignoreRobots) {
    await Promise.all([...origins].map(async origin => {
      try {
        const robotsUrl = `${origin}/robots.txt`;
        const res = await fetch(robotsUrl, {
          headers: { 'User-Agent': 'hagrag/0.0.1' },
          signal: AbortSignal.timeout(10000),
        });
        if (res.ok) robotsByOrigin.set(origin, robotsParser(robotsUrl, await res.text()));
      } catch { /* robots.txt unavailable — proceed without */ }
    }));
  }

  const isAllowed = (url) => {
    const origin = new URL(url).origin;
    const robots = robotsByOrigin.get(origin);
    return !robots || robots.isAllowed(url, 'hagrag') !== false;
  };

  const isInScope = (url) => {
    const parsed = new URL(url);
    if (!origins.has(parsed.origin)) return false;
    if (filterEntries) return filterEntries.some(({ bare, prefix }) =>
      parsed.pathname === bare || parsed.pathname.startsWith(prefix)
    );
    return true;
  };

  const insertNode = db.prepare(`
    INSERT OR IGNORE INTO nodes (id, url, title, content, embedding, depth)
    VALUES (?, ?, ?, ?, ?, ?)
  `);
  const insertEdge = db.prepare(`
    INSERT OR IGNORE INTO edges (from_id, to_id, anchor_text, weight)
    VALUES (?, ?, ?, 1.0)
  `);

  const visited = new Set(seeds);
  const queue = seeds.map(url => ({ url, depth: 0 }));
  let crawled = 0;
  const limit_ = pLimit(concurrency);

  const processPage = async ({ url, depth: d, fromId = null, anchorText = null }) => {
    const id = makeId(url);

    // Insert the inbound edge (even if this node fetch fails)
    if (fromId && anchorText) {
      insertEdge.run(fromId, id, anchorText.slice(0, 500));
    }

    if (!isAllowed(url)) return [];

    let parsed;
    if (adapter.parsePage) {
      // Adapter handles both fetching and parsing in one call
      try {
        parsed = await adapter.parsePage(url);
        if (!parsed) return [];   // adapter signals skip
      } catch {
        return [];
      }
    } else {
      let html;
      if (adapter.fetch) {
        // Adapter overrides fetching only
        try {
          const result = await adapter.fetch(url);
          if (!result) return [];
          html = result.html;
        } catch {
          return [];
        }
      } else {
        // Built-in HTTP fetch
        try {
          const res = await fetch(url, {
            headers: { 'User-Agent': 'hagrag/0.0.1' },
            signal: AbortSignal.timeout(15000),
          });
          if (!res.ok) return [];
          const ct = res.headers.get('content-type') ?? '';
          if (!ct.includes('text/html')) return [];
          html = await res.text();
        } catch {
          return [];
        }
      }
      parsed = adapter.parse(html, url);
    }

    const { title, content, links } = parsed;

    // Resolve, filter, and store links
    const newLinks = [];
    const seenEdgeKeys = new Set();

    if (d < depth) for (const { href, anchorText: anchor } of links) {
      let resolved;
      try { resolved = new URL(href, url).href; } catch { continue; }

      const clean = resolved.split('#')[0];
      if (!clean || clean === url) continue;
      if (!isInScope(clean)) continue;

      const targetId = makeId(clean);
      const anchorTrunc = anchor.slice(0, 500);
      const edgeKey = `${id}\x00${targetId}\x00${anchorTrunc}`;
      if (seenEdgeKeys.has(edgeKey)) continue;
      seenEdgeKeys.add(edgeKey);

      insertEdge.run(id, targetId, anchorTrunc);
      if (!visited.has(clean)) {
        newLinks.push({ url: clean, depth: d + 1, fromId: id, anchorText: anchorTrunc });
      }
    }

    const embedding = embed(content || title || url);
    insertNode.run(id, url, title, content, Buffer.from(embedding.buffer), d);
    crawled++;

    return newLinks;
  };

  // BFS: drain queue in batches, collect newly discovered links
  while (queue.length > 0 && crawled < limit) {
    const batch = queue.splice(0, concurrency);
    const results = await Promise.all(batch.map(item => limit_(() => processPage(item))));

    for (const links of results) {
      for (const link of links) {
        if (!visited.has(link.url) && crawled + queue.length < limit) {
          visited.add(link.url);
          queue.push(link);
        }
      }
    }
  }

  console.log(`Crawled ${crawled} pages. Computing PageRank...`);
  computePageRank(db);
  console.log('Done.');

  return db;
}
