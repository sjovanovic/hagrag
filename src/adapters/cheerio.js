import { load } from 'cheerio';

function extractTitle($) {
  return $('title').text().trim() || $('h1').first().text().trim() || '';
}

function extractContent($) {
  $('script, style, nav, footer, header, aside, noscript').remove();
  const main = $('main, article, [role="main"], #content, #main, .content, .main').first();
  return (main.length ? main : $('body')).text().replace(/\s+/g, ' ').trim();
}

/**
 * Default page adapter using cheerio.
 *
 * parse(html, baseUrl) → { title, content, links }
 *
 * links: Array of { href, anchorText } — raw hrefs as found in the HTML,
 * not yet resolved or filtered. The crawler handles resolution and scope checks.
 */
export const cheerioAdapter = {
  parse(html, _baseUrl) {
    const $ = load(html);
    const title = extractTitle($);

    // Extract links BEFORE extractContent — extractContent mutates the DOM
    // (removes nav/header/footer elements which often contain links)
    const links = [];
    $('a[href]').each((_, el) => {
      const href = $(el).attr('href')?.trim();
      const anchorText = $(el).text().replace(/\s+/g, ' ').trim();
      if (href && anchorText) links.push({ href, anchorText });
    });

    const content = extractContent($);
    return { title, content, links };
  },
};
