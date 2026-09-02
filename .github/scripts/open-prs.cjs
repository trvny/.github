'use strict';

const OPEN_PRS_START_MARKER = '<!--OPEN_PRS:START-->';
const OPEN_PRS_END_MARKER = '<!--OPEN_PRS:END-->';

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function markerPattern(start, end) {
  return new RegExp(`${escapeRegExp(start)}[\\s\\S]*?${escapeRegExp(end)}`);
}

function cell(value) {
  return String(value ?? '')
    .replace(/\r?\n/g, ' ')
    .replace(/\|/g, '\\|');
}

async function listOpenPrs({ github, owner, qualifier = 'user' }) {
  const items = await github.paginate(
    github.rest.search.issuesAndPullRequests,
    {
      q: `${qualifier}:${owner} is:pr is:open`,
      per_page: 100,
    },
  );

  return items
    .map((item) => ({
      ...item,
      repository: item.repository_url.split('/').slice(-2).join('/'),
    }))
    .sort(
      (a, b) =>
        a.repository.localeCompare(b.repository) || a.number - b.number,
    );
}

function renderOpenPrTable(prs) {
  if (prs.length === 0) {
    return 'No open pull requests. 🎉';
  }

  return [
    '| Repository | PR | Title | Author | State | Updated |',
    '| --- | ---: | --- | --- | --- | --- |',
    ...prs.map(
      (pr) =>
        `| ${cell(pr.repository)} | [#${pr.number}](${pr.html_url}) | ${cell(pr.title)} | @${cell(pr.user?.login)} | ${pr.draft ? 'draft' : 'ready'} | ${pr.updated_at.slice(0, 10)} |`,
    ),
  ].join('\n');
}

function renderOpenPrBlock(prs) {
  return [
    OPEN_PRS_START_MARKER,
    renderOpenPrTable(prs),
    OPEN_PRS_END_MARKER,
  ].join('\n');
}

function replaceOpenPrBlock(readme, block) {
  const pattern = markerPattern(OPEN_PRS_START_MARKER, OPEN_PRS_END_MARKER);
  if (!pattern.test(readme)) {
    throw new Error(`Missing dynamic README block: ${OPEN_PRS_START_MARKER}`);
  }
  return readme.replace(pattern, block);
}

module.exports = {
  OPEN_PRS_END_MARKER,
  OPEN_PRS_START_MARKER,
  listOpenPrs,
  renderOpenPrBlock,
  renderOpenPrTable,
  replaceOpenPrBlock,
};
