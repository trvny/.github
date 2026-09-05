'use strict';

const updateSourceReadme = require('./update-readme-quote.cjs');
const {
  DEFAULT_OPEN_PR_LABELS,
  OPEN_PRS_START_MARKER,
  listOpenPrs,
  listPublicOrgOpenPrs,
  renderOpenPrBlock,
  replaceOpenPrBlock,
} = require('./open-prs.cjs');

const QUOTE_START_MARKER = '<!--STARTS_HERE_QUOTE_README-->';
const QUOTE_END_MARKER = '<!--ENDS_HERE_QUOTE_README-->';
const FEED_START_MARKER = '<!--README_FEED:START-->';
const FEED_END_MARKER = '<!--README_FEED:END-->';
const README_MODES = new Set(['both', 'feed', 'quote']);
const README_PATHS = ['README.md', 'README_pl.md', 'README_zh.md'];
const PROFILE_README_PATHS = [
  'README.md',
  'profile/README.md',
  'profile/README_pl.md',
  'profile/README_zh.md',
];
const OPEN_PR_LABELS = {
  'README.md': DEFAULT_OPEN_PR_LABELS,
  'README_pl.md': {
    repository: 'Repozytorium',
    title: 'Tytuł',
    author: 'Autor',
    state: 'Stan',
    updated: 'Aktualizacja',
    draft: 'wersja robocza',
    ready: 'gotowy',
    empty: 'Brak otwartych pull requestów. 🎉',
  },
  'README_zh.md': {
    repository: '仓库',
    title: '标题',
    author: '作者',
    state: '状态',
    updated: '更新',
    draft: '草稿',
    ready: '就绪',
    empty: '没有开放的拉取请求。🎉',
  },
};
const PROFILE_OPEN_PR_LABELS = {
  'profile/README.md': DEFAULT_OPEN_PR_LABELS,
  'profile/README_pl.md': OPEN_PR_LABELS['README_pl.md'],
  'profile/README_zh.md': OPEN_PR_LABELS['README_zh.md'],
};

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function markerPattern(start, end) {
  return new RegExp(`${escapeRegExp(start)}[\\s\\S]*?${escapeRegExp(end)}`);
}

function extractBlock(readme, start, end) {
  const block = readme.match(markerPattern(start, end))?.[0];
  if (!block) {
    throw new Error(`Missing dynamic README block: ${start}`);
  }
  return block;
}

function parseTargets(value) {
  const targets = (value || '')
    .split(/[\n,]+/)
    .map((item) => item.trim())
    .filter(Boolean);
  const parsed = new Map();

  for (const target of targets) {
    const separator = target.lastIndexOf(':');
    const repository = separator === -1 ? target : target.slice(0, separator);
    const mode = separator === -1 ? 'both' : target.slice(separator + 1).toLowerCase();

    if (!/^[^/\s]+\/[^/\s]+$/.test(repository)) {
      throw new Error(`Invalid README target: ${target}`);
    }
    if (!README_MODES.has(mode)) {
      throw new Error(`Invalid README mode for ${repository}: ${mode}`);
    }
    if (parsed.has(repository) && parsed.get(repository) !== mode) {
      throw new Error(`Conflicting README modes for ${repository}`);
    }
    parsed.set(repository, mode);
  }

  return [...parsed].map(([repository, mode]) => ({ repository, mode }));
}

function syncBlocks(readme, feedBlock, quoteBlock, mode = 'both') {
  if (!README_MODES.has(mode)) {
    throw new Error(`Invalid README mode: ${mode}`);
  }

  const feedPattern = markerPattern(FEED_START_MARKER, FEED_END_MARKER);
  const quotePattern = markerPattern(QUOTE_START_MARKER, QUOTE_END_MARKER);
  const additions = [];
  let updated = readme;

  if (mode !== 'quote') {
    if (feedPattern.test(updated)) {
      updated = updated.replace(feedPattern, feedBlock);
    } else {
      additions.push(`## 📰 Mininewsy\n\n${feedBlock}`);
    }
  }

  if (mode !== 'feed') {
    if (quotePattern.test(updated)) {
      updated = updated.replace(quotePattern, quoteBlock);
    } else {
      additions.push(
        [
          '## 💬 Cytat z szuflady',
          '',
          '<!-- markdownlint-disable MD033 -->',
          quoteBlock,
          '<!-- markdownlint-enable MD033 -->',
        ].join('\n'),
      );
    }
  }

  if (additions.length > 0) {
    updated = `${updated.trimEnd()}\n\n${additions.join('\n\n')}\n`;
  }

  return updated;
}

function hasRequestedBlocks(readme, mode = 'both') {
  if (!README_MODES.has(mode)) {
    throw new Error(`Invalid README mode: ${mode}`);
  }

  const hasFeed =
    readme.includes(FEED_START_MARKER) && readme.includes(FEED_END_MARKER);
  const hasQuote =
    readme.includes(QUOTE_START_MARKER) && readme.includes(QUOTE_END_MARKER);

  return (mode === 'quote' || hasFeed) && (mode === 'feed' || hasQuote);
}

async function fetchReadme(github, owner, repo, path = 'README.md') {
  const repository = await github.rest.repos.get({ owner, repo });
  const branch = repository.data.default_branch;
  const response = await github.rest.repos.getContent({
    owner,
    repo,
    path,
    ref: branch,
  });

  if (Array.isArray(response.data) || response.data.type !== 'file') {
    throw new Error(`${owner}/${repo}/${path} is not a file`);
  }

  return {
    branch,
    content: Buffer.from(response.data.content, 'base64').toString('utf8'),
    sha: response.data.sha,
  };
}

async function updateReadme({
  github,
  core,
  owner,
  repo,
  path,
  mode,
  feedBlock,
  quoteBlock,
  openPrs,
  openPrLabels,
}) {
  let readme;
  try {
    readme = await fetchReadme(github, owner, repo, path);
  } catch (error) {
    if (path !== 'README.md' && error.status === 404) {
      core.info(`${owner}/${repo}/${path}: file does not exist, skipping.`);
      return;
    }
    throw error;
  }

  if (path !== 'README.md' && !hasRequestedBlocks(readme.content, mode)) {
    core.info(`${owner}/${repo}/${path}: dynamic blocks not present, skipping.`);
    return;
  }

  let updated = syncBlocks(readme.content, feedBlock, quoteBlock, mode);
  if (openPrs && openPrLabels && updated.includes(OPEN_PRS_START_MARKER)) {
    updated = replaceOpenPrBlock(
      updated,
      renderOpenPrBlock(openPrs, openPrLabels),
    );
  }

  if (updated === readme.content) {
    core.info(`${owner}/${repo}/${path}: dynamic content is unchanged.`);
    return;
  }

  await github.rest.repos.createOrUpdateFileContents({
    owner,
    repo,
    path,
    branch: readme.branch,
    message: 'chore(readme): refresh shared content [skip ci]',
    content: Buffer.from(updated, 'utf8').toString('base64'),
    sha: readme.sha,
  });
  core.info(`${owner}/${repo}/${path}: README updated.`);
}

module.exports = async function updateSharedReadmes({ github, context, core }) {
  await updateSourceReadme({ github, context, core });

  const source = await fetchReadme(github, context.repo.owner, context.repo.repo);
  const feedBlock = extractBlock(source.content, FEED_START_MARKER, FEED_END_MARKER);
  const quoteBlock = extractBlock(
    source.content,
    QUOTE_START_MARKER,
    QUOTE_END_MARKER,
  );
  const openPrs = await listOpenPrs({ github, owner: context.repo.owner });
  const mainRepository = `${context.repo.owner}/trvny`;
  const failures = [];

  for (const target of parseTargets(process.env.README_TARGET_REPOS)) {
    const [owner, repo] = target.repository.split('/');
    core.startGroup(`Update ${target.repository} (${target.mode})`);
    try {
      for (const path of README_PATHS) {
        await updateReadme({
          github,
          core,
          owner,
          repo,
          path,
          mode: target.mode,
          feedBlock,
          quoteBlock,
          openPrs: target.repository === mainRepository ? openPrs : null,
          openPrLabels:
            target.repository === mainRepository ? OPEN_PR_LABELS[path] : null,
        });
      }
    } catch (error) {
      failures.push(`${target.repository}: ${error.message}`);
      core.error(failures.at(-1));
    } finally {
      core.endGroup();
    }
  }

  for (const target of parseTargets(process.env.README_PROFILE_TARGET_REPOS)) {
    const [owner, repo] = target.repository.split('/');
    core.startGroup(`Update organization profile ${target.repository} (${target.mode})`);
    try {
      const profileOpenPrs = await listPublicOrgOpenPrs({ github, org: owner });
      for (const path of PROFILE_README_PATHS) {
        await updateReadme({
          github,
          core,
          owner,
          repo,
          path,
          mode: target.mode,
          feedBlock,
          quoteBlock,
          openPrs: profileOpenPrs,
          openPrLabels: PROFILE_OPEN_PR_LABELS[path],
        });
      }
    } catch (error) {
      failures.push(`${target.repository}: ${error.message}`);
      core.error(failures.at(-1));
    } finally {
      core.endGroup();
    }
  }

  if (failures.length > 0) {
    core.setFailed(`${failures.length} README target(s) could not be updated`);
  }
};

module.exports._test = {
  extractBlock,
  hasRequestedBlocks,
  parseTargets,
  syncBlocks,
};
