import { embed, cosineSim } from '@ternlight/base';

function combinedScore(node) {
  const semantic = node.sim ?? 0;
  const hopDecay = 1 / (1 + node.hops);
  const authority = node.pagerank ?? 0;
  const anchorRelevance = node.edgeLabels?.length ? 0.1 : 0;
  return 0.5 * semantic + 0.25 * hopDecay + 0.15 * authority + 0.1 * anchorRelevance;
}

function assembleContext(nodes, budget) {
  // Build a lookup by id for path reconstruction
  const byId = new Map(nodes.map(n => [n.id, n]));

  // Per-entry content budget: no single entry should consume more than half the total
  const entryLimit = Math.floor(budget / 2);

  const paths = nodes.map(node => {
    const content = (node.content || '').slice(0, entryLimit);
    let text;

    if (!node.path || node.path.length <= 1) {
      text = `[${node.title || node.url}](${node.url})\n${content}`;
    } else {
      let pathText = '';
      for (let i = 0; i < node.path.length - 1; i++) {
        const from = byId.get(node.path[i]);
        const label = node.edgeLabels[i];
        pathText += `[${from?.title || node.path[i]}] --"${label}"--> `;
      }
      pathText += `[${node.title || node.url}](${node.url})\n${content}`;
      text = pathText;
    }

    return { text, weight: combinedScore(node) };
  });

  paths.sort((a, b) => b.weight - a.weight);

  let context = '';
  for (const p of paths) {
    // Always include the first entry; skip subsequent ones that overflow the budget
    if (context.length > 0 && context.length + p.text.length > budget) break;
    context += p.text + '\n\n---\n\n';
  }
  return context;
}

export function query(db, userPrompt, {
  beamWidth = 3,
  maxHops = 2,
  seedCount = 5,
  contextBudget = 8000,
} = {}) {
  const queryEmb = embed(userPrompt);

  // Load all nodes for brute-force kNN (sufficient for ≤ ~200K embeddings)
  const allNodes = db.prepare(
    'SELECT id, url, title, content, embedding, pagerank FROM nodes WHERE embedding IS NOT NULL'
  ).all();

  if (allNodes.length === 0) return '';

  const scored = allNodes
    .map(n => ({
      ...n,
      sim: cosineSim(queryEmb, new Float32Array(n.embedding.buffer)),
    }))
    .sort((a, b) => b.sim - a.sim);

  const seeds = scored.slice(0, seedCount);

  // Graph expansion via typed edges (beam search with score decay)
  const visited = new Set(seeds.map(s => s.id));
  let frontier = seeds.map(s => ({
    ...s,
    hops: 0,
    path: [s.id],
    edgeLabels: [],
  }));
  const context = [];

  const neighborStmt = db.prepare(`
    SELECT n.id, n.url, n.title, n.content, n.embedding, n.pagerank,
           e.anchor_text, e.weight
    FROM edges e
    JOIN nodes n ON n.id = e.to_id
    WHERE e.from_id = ?
    ORDER BY e.weight DESC
    LIMIT ?
  `);

  while (frontier.length > 0) {
    const batch = frontier
      .sort((a, b) => combinedScore(b) - combinedScore(a))
      .slice(0, beamWidth);

    frontier = [];

    for (const node of batch) {
      context.push(node);
      if (node.hops >= maxHops) continue;

      const neighbors = neighborStmt.all(node.id, beamWidth * 2);

      for (const n of neighbors) {
        if (visited.has(n.id)) continue;
        visited.add(n.id);

        frontier.push({
          ...n,
          sim: cosineSim(queryEmb, new Float32Array(n.embedding.buffer)),
          hops: node.hops + 1,
          path: [...node.path, n.id],
          edgeLabels: [...node.edgeLabels, n.anchor_text],
        });
      }
    }
  }

  return assembleContext(context, contextBudget);
}
