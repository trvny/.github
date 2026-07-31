'use strict';

const { randomInt } = require('node:crypto');

const START_MARKER = '<!--STARTS_HERE_QUOTE_README-->';
const END_MARKER = '<!--ENDS_HERE_QUOTE_README-->';
const FEED_START_MARKER = '<!--README_FEED:START-->';
const FEED_END_MARKER = '<!--README_FEED:END-->';
const DEFAULT_GIST_ID = '167d2271e3cf7d21e118aa7d906a7d2c';
const DEFAULT_FEED_URL =
  'https://raw.githubusercontent.com/trvny/feeds/main/feedseek/feeds/feed_daily_digest.xml';
const UPSTREAM_BASE =
  'https://raw.githubusercontent.com/offensive-vk/auto-update-quote/v7';

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function escapeHtml(value) {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;');
}

function decodeHtml(value) {
  return value
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&amp;', '&');
}

function decodeCodePoint(value, radix) {
  const codePoint = Number.parseInt(value, radix);
  return Number.isInteger(codePoint) && codePoint <= 0x10ffff
    ? String.fromCodePoint(codePoint)
    : '';
}

function decodeXml(value) {
  return value
    .replace(/^<!\[CDATA\[([\s\S]*)\]\]>$/i, '$1')
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => decodeCodePoint(hex, 16))
    .replace(/&#(\d+);/g, (_, decimal) => decodeCodePoint(decimal, 10))
    .replaceAll('&quot;', '"')
    .replaceAll('&apos;', "'")
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&amp;', '&');
}

function normalize(value) {
  return value
    .normalize('NFKC')
    .replace(/<[^>]+>/g, ' ')
    .replace(/[❝❞“”„«»]/g, '"')
    .replace(/\s+/g, ' ')
    .trim()
    .toLocaleLowerCase('pl');
}

function cleanLine(value) {
  let line = value.trim();
  if (!line || /^```/.test(line) || /^#{1,6}\s/.test(line)) {
    return null;
  }

  line = line
    .replace(/^>\s?/, '')
    .replace(/^[-*+]\s+/, '')
    .replace(/^\d+[.)]\s+/, '')
    .replace(/^\[[ xX]\]\s+/, '')
    .replace(/^\|\s*/, '')
    .replace(/\s*\|$/, '')
    .trim();

  if (/^https?:\/\/\S+$/i.test(line) || line.length < 8 || line.length > 600) {
    return null;
  }

  return line;
}

function fromStructuredValue(value) {
  if (typeof value === 'string') {
    return [value];
  }
  if (Array.isArray(value)) {
    return value.flatMap(fromStructuredValue);
  }
  if (!value || typeof value !== 'object') {
    return [];
  }

  const text = value.quote ?? value.text ?? value.content ?? value.fact;
  if (typeof text === 'string') {
    const author = value.author ?? value.source ?? value.by;
    return [author ? `${text} — ${author}` : text];
  }

  const preferred = value.quotes ?? value.facts ?? value.items ?? value.entries;
  if (preferred) {
    return fromStructuredValue(preferred);
  }

  return Object.values(value).flatMap(fromStructuredValue);
}

function parseCandidates(content) {
  const trimmed = content.trim();
  if (!trimmed) {
    return [];
  }

  try {
    const parsed = JSON.parse(trimmed);
    const structured = fromStructuredValue(parsed)
      .map(cleanLine)
      .filter(Boolean);
    if (structured.length > 0) {
      return structured;
    }
  } catch {
    // Plain text and Markdown are handled below.
  }

  const paragraphs = trimmed
    .split(/\n\s*\n+/)
    .map((block) => block.split('\n').map(cleanLine).filter(Boolean).join(' '))
    .map(cleanLine)
    .filter(Boolean);

  const lines = trimmed.split('\n').map(cleanLine).filter(Boolean);
  return [...paragraphs, ...lines];
}

function deduplicate(values) {
  const seen = new Set();
  return values.filter((value) => {
    const key = normalize(value);
    if (!key || seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}

async function fetchText(url, headers = {}) {
  const response = await fetch(url, { headers });
  if (!response.ok) {
    throw new Error(`GET ${url} returned ${response.status}`);
  }
  return response.text();
}

async function fetchGistCandidates(gistId, token) {
  const headers = {
    Accept: 'application/vnd.github+json',
    'User-Agent': 'trvny-readme',
    'X-GitHub-Api-Version': '2026-03-10',
  };
  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }

  const response = await fetch(`https://api.github.com/gists/${gistId}`, {
    headers,
  });
  if (!response.ok) {
    throw new Error(`Gist API returned ${response.status}`);
  }

  const gist = await response.json();
  const candidates = [];
  for (const file of Object.values(gist.files ?? {})) {
    let content = file.content ?? '';
    if (file.truncated && file.raw_url) {
      content = await fetchText(file.raw_url, headers);
    }
    candidates.push(...parseCandidates(content));
  }
  return deduplicate(candidates);
}

function currentQuote(readme) {
  const pattern = markerPattern(START_MARKER, END_MARKER);
  const match = readme.match(pattern);
  if (!match) {
    return '';
  }

  const rendered = decodeHtml(match[1])
    .replace(/<[^>]+>/g, ' ')
    .trim()
    .replace(/^❝/, '')
    .replace(/❞$/, '');
  return normalize(rendered);
}

function markerPattern(start, end, capture = true) {
  const middle = capture ? '([\\s\\S]*?)' : '[\\s\\S]*?';
  return new RegExp(`${escapeRegExp(start)}${middle}${escapeRegExp(end)}`);
}

function pickSource(sources) {
  const available = sources.filter((source) => source.items.length > 0);
  if (available.length === 0) {
    throw new Error('No quote or fact candidates were loaded');
  }
  return available[randomInt(available.length)];
}

function pickItem(items, previous) {
  const fresh = items.filter((item) => normalize(item) !== previous);
  const pool = fresh.length > 0 ? fresh : items;
  return pool[randomInt(pool.length)];
}

function extractTag(block, names) {
  for (const name of names) {
    const pattern = new RegExp(
      `<(?:[\\w.-]+:)?${escapeRegExp(name)}\\b[^>]*>([\\s\\S]*?)<\\/(?:[\\w.-]+:)?${escapeRegExp(name)}>`,
      'i',
    );
    const match = block.match(pattern);
    if (match) {
      return match[1].trim();
    }
  }
  return '';
}

function cleanFeedText(value) {
  return decodeXml(value)
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function safeHttpUrl(value) {
  try {
    const url = new URL(decodeXml(value).trim());
    return ['http:', 'https:'].includes(url.protocol) ? url.href : '';
  } catch {
    return '';
  }
}

function extractLink(block) {
  const tags = [...block.matchAll(/<(?:[\w.-]+:)?link\b([^>]*)\/?\s*>/gi)];
  for (const match of tags) {
    const attributes = match[1];
    const href = attributes.match(/\bhref\s*=\s*(["'])(.*?)\1/i)?.[2];
    const rel = attributes.match(/\brel\s*=\s*(["'])(.*?)\1/i)?.[2];
    if (href && (!rel || rel.toLowerCase() === 'alternate')) {
      const safe = safeHttpUrl(href);
      if (safe) {
        return safe;
      }
    }
  }

  return safeHttpUrl(cleanFeedText(extractTag(block, ['link', 'guid'])));
}

function parseFeedDate(block) {
  const value = cleanFeedText(
    extractTag(block, ['published', 'updated', 'pubDate', 'date']),
  );
  const timestamp = Date.parse(value);
  return Number.isNaN(timestamp) ? 0 : timestamp;
}

function parseFeedEntries(xml, sourceUrl) {
  const blocks = [];
  for (const tag of ['entry', 'item']) {
    const pattern = new RegExp(
      `<(?:[\\w.-]+:)?${tag}\\b[^>]*>([\\s\\S]*?)<\\/(?:[\\w.-]+:)?${tag}>`,
      'gi',
    );
    for (const match of xml.matchAll(pattern)) {
      blocks.push(match[1]);
    }
  }

  return blocks.flatMap((block, index) => {
    const title = cleanFeedText(extractTag(block, ['title']));
    const url = extractLink(block);
    if (!title || !url) {
      return [];
    }
    return [{ title, url, timestamp: parseFeedDate(block), sourceUrl, index }];
  });
}

function parseFeedUrls(value) {
  const urls = (value || DEFAULT_FEED_URL)
    .split(/[\n,]+/)
    .map((item) => safeHttpUrl(item))
    .filter(Boolean);
  return [...new Set(urls)];
}

function feedLimit(value) {
  const parsed = Number.parseInt(value ?? '5', 10);
  return Number.isFinite(parsed) ? Math.min(10, Math.max(1, parsed)) : 5;
}

function escapeMarkdown(value) {
  return value.replace(/[\\`*_[\]()]/g, '\\$&');
}

function truncate(value, limit = 180) {
  const characters = [...value];
  return characters.length <= limit
    ? value
    : `${characters.slice(0, limit - 1).join('').trimEnd()}…`;
}

function selectFeedEntries(entries, limit) {
  const seenTitles = new Set();
  const seenUrls = new Set();
  return [...entries]
    .sort((a, b) => b.timestamp - a.timestamp || a.index - b.index)
    .filter((entry) => {
      const title = normalize(entry.title);
      if (seenTitles.has(title) || seenUrls.has(entry.url)) {
        return false;
      }
      seenTitles.add(title);
      seenUrls.add(entry.url);
      return true;
    })
    .slice(0, limit);
}

function renderFeed(entries) {
  return [
    FEED_START_MARKER,
    ...entries.map(
      (entry) => `- [${escapeMarkdown(truncate(entry.title))}](${entry.url})`,
    ),
    FEED_END_MARKER,
  ].join('\n');
}

async function loadFeedEntries(urls, core) {
  const entries = [];
  for (const url of urls) {
    try {
      const xml = await fetchText(url, {
        Accept: 'application/atom+xml, application/rss+xml, application/xml, text/xml',
        'User-Agent': 'trvny-readme',
      });
      entries.push(...parseFeedEntries(xml, url));
    } catch (error) {
      core.warning(`Feed unavailable (${url}): ${error.message}`);
    }
  }
  return entries;
}

module.exports = async function updateReadme({ github, context, core }) {
  const { owner, repo } = context.repo;
  const gistId = process.env.GIST_ID || DEFAULT_GIST_ID;
  const readmePath = process.env.README_PATH || 'README.md';

  const repository = await github.rest.repos.get({ owner, repo });
  const branch = repository.data.default_branch;
  const response = await github.rest.repos.getContent({
    owner,
    repo,
    path: readmePath,
    ref: branch,
  });

  if (Array.isArray(response.data) || response.data.type !== 'file') {
    throw new Error(`${readmePath} is not a file`);
  }

  const readme = Buffer.from(response.data.content, 'base64').toString('utf8');
  const quotePattern = markerPattern(START_MARKER, END_MARKER, false);
  const feedPattern = markerPattern(FEED_START_MARKER, FEED_END_MARKER, false);
  if (!quotePattern.test(readme) || !feedPattern.test(readme)) {
    throw new Error(`README markers are missing from ${readmePath}`);
  }

  const sources = [];
  try {
    sources.push({
      name: 'personal gist',
      items: await fetchGistCandidates(gistId, process.env.GIST_TOKEN),
    });
  } catch (error) {
    core.warning(`Personal gist unavailable: ${error.message}`);
  }

  for (const [name, path] of [
    ['upstream quotes', 'quotes/quotes.txt'],
    ['upstream fun facts', 'funfacts/funfacts.txt'],
  ]) {
    try {
      const content = await fetchText(`${UPSTREAM_BASE}/${path}`);
      sources.push({ name, items: deduplicate(parseCandidates(content)) });
    } catch (error) {
      core.warning(`${name} unavailable: ${error.message}`);
    }
  }

  let sourceName = 'current quote';
  let updated = readme;
  try {
    const source = pickSource(sources);
    const quote = pickItem(source.items, currentQuote(readme));
    const quoteReplacement = [
      START_MARKER,
      `<i>❝${escapeHtml(quote)}❞</i>`,
      END_MARKER,
    ].join('\n');
    updated = updated.replace(quotePattern, quoteReplacement);
    sourceName = source.name;
  } catch (error) {
    core.warning(`Quote sources unavailable: ${error.message}`);
  }

  const feedUrls = parseFeedUrls(process.env.README_FEED_URLS);
  const loadedEntries = await loadFeedEntries(feedUrls, core);
  const feedEntries = selectFeedEntries(
    loadedEntries,
    feedLimit(process.env.README_FEED_MAX_ENTRIES),
  );
  if (feedEntries.length > 0) {
    updated = updated.replace(feedPattern, renderFeed(feedEntries));
  } else {
    core.warning('No feed entries loaded; preserving the current README feed block.');
  }

  if (updated === readme) {
    core.info('Dynamic README content is unchanged; nothing to commit.');
    return;
  }

  await github.rest.repos.createOrUpdateFileContents({
    owner,
    repo,
    path: readmePath,
    branch,
    message: 'chore(readme): refresh dynamic content',
    content: Buffer.from(updated, 'utf8').toString('base64'),
    sha: response.data.sha,
  });

  core.info(
    `README updated from ${sourceName} and ${feedEntries.length} feed entries.`,
  );
};

module.exports._test = {
  parseFeedEntries,
  parseFeedUrls,
  selectFeedEntries,
  renderFeed,
};
