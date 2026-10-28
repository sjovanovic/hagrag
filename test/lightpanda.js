import { lightpanda } from '@lightpanda/browser';

const url = 'https://github.com/autodesk-platform-services/open-architecture-standards-2d-floor-plans/tree/main/docs';

// Single fetch: Markdown dump
const markdown = await lightpanda.fetch(url, { dump:true, disableHostVerification:true, obeyRobots:false, dumpOptions:{type: 'markdown'} });

const result = {
  title: extractTitle(markdown),
  content: markdown,
  links: extractLinks(markdown),
};

console.log(JSON.stringify(result, null, 2));

// ---------------------------------------------------------------------------
// Title extraction (best effort — Markdown has no <title>)
// ---------------------------------------------------------------------------
function extractTitle(md) {
  // ATX heading: # Title, ## Title ##, up to ######
  const atx = /^(#{1,6})[ \t]+(.+?)[ \t]*#*[ \t]*$/m.exec(md);
  if (atx) return stripInlineMd(atx[2].trim());

  // Setext heading: Title\n===== or Title\n-----
  const setext = /^(?!\s*$)(.+)\n(?:={2,}|-{2,})[ \t]*$/m.exec(md);
  if (setext) return stripInlineMd(setext[1].trim());

  // Fallback: first non-empty, non-heading line
  const first = md
    .split(/\r?\n/)
    .find((line) => line.trim() && !/^\s*#{1,6}\s/.test(line));

  return first ? stripInlineMd(first.trim()) : '';
}

function stripInlineMd(s) {
  return s
    // images -> alt text
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    // links -> anchor text
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    // emphasis / code markers
    .replace(/[*_~`]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

// ---------------------------------------------------------------------------
// Link extraction
// ---------------------------------------------------------------------------
function extractLinks(md) {
  const links = [];
  const refs = new Map();

  // 1. Reference definitions: [label]: <url> "title"
  //    Also handles: [label]: url 'title', [label]: url (title)
  const refDefRe =
    /^[ \t]{0,3}\[([^\]]+)\]:[ \t]*(?:<([^>]+)>|(\S+))(?:[ \t]+(?:"([^"]*)"|'([^']*)'|\(([^)]*)\)))?[ \t]*$/gm;

  let m;
  while ((m = refDefRe.exec(md))) {
    const label = m[1].trim().toLowerCase();
    const href = m[2] ?? m[3]; // m[2] = <...> form, m[3] = bare form
    if (href) refs.set(label, href);
  }

  // 2. Scan for inline links, full/collapsed reference links, autolinks
  let i = 0;
  while (i < md.length) {
    const c = md[i];

    // Inline link: [text](dest "title")
    if (c === '[' && md[i - 1] !== '!' && md[i - 1] !== '\\') {
      const textEnd = findMatchingBracket(md, i);
      if (textEnd !== -1 && md[textEnd + 1] === '(') {
        const destEnd = findMatchingParen(md, textEnd + 1);
        if (destEnd !== -1) {
          const anchorText = md.slice(i + 1, textEnd);
          const href = parseDestination(md.slice(textEnd + 2, destEnd));
          if (href) links.push({ href, anchorText: cleanAnchor(anchorText) });
          i = destEnd + 1;
          continue;
        }
      }
    }

    // Full / collapsed reference link: [text][label] or [text][]
    if (c === '[' && md[i - 1] !== '!' && md[i - 1] !== '\\') {
      const textEnd = findMatchingBracket(md, i);
      if (textEnd !== -1 && md[textEnd + 1] === '[') {
        const labelEnd = findMatchingBracket(md, textEnd + 1);
        if (labelEnd !== -1) {
          const anchorText = md.slice(i + 1, textEnd);
          const label =
            md.slice(textEnd + 2, labelEnd).trim().toLowerCase() ||
            anchorText.trim().toLowerCase();
          const href = refs.get(label);
          if (href) links.push({ href, anchorText: cleanAnchor(anchorText) });
          i = labelEnd + 1;
          continue;
        }
      }
    }

    // Autolink: <https://...> or <user@example.com>
    if (c === '<') {
      const close = md.indexOf('>', i + 1);
      if (close !== -1) {
        const inside = md.slice(i + 1, close);
        if (
          /^[A-Za-z][A-Za-z0-9+.-]{1,31}:[^<>\s]+$/.test(inside) ||
          /^[^<>\s]+@[^<>\s]+\.[^<>\s]+$/.test(inside)
        ) {
          links.push({ href: inside, anchorText: inside });
          i = close + 1;
          continue;
        }
      }
    }

    i++;
  }

  return links;
}

// Find matching `]` for a `[` at openIdx, respecting escapes and nesting.
function findMatchingBracket(s, openIdx) {
  let depth = 0;
  for (let i = openIdx; i < s.length; i++) {
    if (s[i] === '\\') {
      i++;
      continue;
    }
    if (s[i] === '[') depth++;
    else if (s[i] === ']') {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

// Find matching `)` for a `(` at openIdx, respecting escapes, quotes, angle brackets,
// and balanced parentheses inside the destination.
function findMatchingParen(s, openIdx) {
  let depth = 0;
  let inAngle = false;
  let quote = null;

  for (let i = openIdx; i < s.length; i++) {
    const c = s[i];

    if (c === '\\') {
      i++;
      continue;
    }
    if (quote) {
      if (c === quote) quote = null;
      continue;
    }
    if (c === '"' || c === "'") {
      quote = c;
      continue;
    }
    if (c === '<') {
      inAngle = true;
      continue;
    }
    if (c === '>') {
      inAngle = false;
      continue;
    }
    if (inAngle) continue;

    if (c === '(') depth++;
    else if (c === ')') {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

// Parse the inside of `(...)` into a URL, stripping an optional title.
function parseDestination(inside) {
  let s = inside.trim();

  // Optional trailing title: "title", 'title', or (title)
  const titleRe = /(?:\s+)(?:"([^"]*)"|'([^']*)'|\(([^)]*)\))\s*$/;
  const t = titleRe.exec(s);
  if (t) s = s.slice(0, t.index).trim();

  // Angle-bracket form: <https://example.com>
  if (s.startsWith('<') && s.endsWith('>')) s = s.slice(1, -1);

  return s || null;
}

function cleanAnchor(text) {
  return text
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1') // images -> alt
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')  // links -> text
    .replace(/[*_~`]/g, '')                    // emphasis / code
    .replace(/\s+/g, ' ')
    .trim();
}