"use strict";

const fs = require("node:fs");
const path = require("node:path");

const SEARCHES = [
  "is:pr is:merged user:trvny",
  "is:pr is:merged org:travnie",
];
const OUTPUT = "assets/profile/merged-prs.svg";

function renderBadge(total) {
  const label = "merged PRs";
  const value = total.toLocaleString("en-US");
  const left = Math.ceil(36 + label.length * 6.2);
  const right = Math.ceil(20 + value.length * 6.4);
  const width = left + right;
  const icon = '<circle cx="6" cy="3" r="2"/><path d="M6 5v12"/><circle cx="6" cy="19" r="2"/><circle cx="18" cy="6" r="2"/><path d="M18 8v4a6 6 0 0 1-6 6H8"/>';
  return '<svg xmlns="http://www.w3.org/2000/svg" width="' + width +
    '" height="20" viewBox="0 0 ' + width + ' 20" role="img" aria-label="' + label + ': ' + value + '">' +
    '<title>' + label + ': ' + value + '</title>' +
    '<rect width="' + left + '" height="20" fill="#30363d"/>' +
    '<rect x="' + left + '" width="' + right + '" height="20" fill="#8250df"/>' +
    '<g transform="translate(5 3) scale(0.58)" fill="none" stroke="#fff" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round">' + icon + '</g>' +
    '<g font-family="Verdana,DejaVu Sans,sans-serif" font-size="11" fill="#fff">' +
    '<text x="' + (left - 9) + '" y="14" text-anchor="end">' + label + '</text>' +
    '<text x="' + (left + right / 2) + '" y="14" text-anchor="middle">' + value + '</text>' +
    '</g></svg>\n';
}

module.exports = async function generateMergedPrBadge({ github, core, outputPath = OUTPUT }) {
  let count = 0;
  try {
    for (const q of SEARCHES) {
      const { data } = await github.rest.search.issuesAndPullRequests({ q, per_page: 1 });
      if (!Number.isSafeInteger(data.total_count) || data.total_count < 0 ||
          data.incomplete_results || !Number.isSafeInteger(count + data.total_count)) {
        throw new Error("Incomplete merged PR search: " + q);
      }
      count += data.total_count;
    }
  } catch (error) {
    if (!fs.existsSync(outputPath)) throw error;
    core.warning("Merged PR count unavailable; retaining last good badge: " + error.message);
    return;
  }

  const svg = renderBadge(count);
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  if (!fs.existsSync(outputPath) || fs.readFileSync(outputPath, "utf8") !== svg) {
    fs.writeFileSync(outputPath, svg, "utf8");
  }
  core.info("Merged PRs across trvny and travnie: " + count);
};
