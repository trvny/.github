"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const generate = require("./generate-merged-prs.cjs");

async function withBadge(callback) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "merged-prs-"));
  try {
    await callback(path.join(dir, "merged-prs.svg"));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test("sums merged PRs for both owners and renders an icon badge", async () => {
  await withBadge(async (outputPath) => {
    const queries = [];
    await generate({
      outputPath,
      core: { info() {}, warning() { throw Error("Unexpected warning"); } },
      github: { rest: { search: { issuesAndPullRequests: async ({ q, per_page }) => {
        queries.push(q);
        assert.equal(per_page, 1);
        return { data: { total_count: q.includes("user:") ? 1234 : 567, incomplete_results: false } };
      } } } },
    });
    assert.deepEqual(queries, ["is:pr is:merged user:trvny", "is:pr is:merged org:travnie"]);
    const svg = fs.readFileSync(outputPath, "utf8");
    assert.match(svg, /merged PRs: 1,801/);
    assert.match(svg, /<circle cx="6"/);
  });
});

test("API failure retains the previous badge", async () => {
  await withBadge(async (outputPath) => {
    fs.writeFileSync(outputPath, "previous badge");
    const warnings = [];
    await generate({
      outputPath,
      core: { info() {}, warning: (message) => warnings.push(message) },
      github: { rest: { search: { issuesAndPullRequests: async () => {
        throw new Error("rate limited");
      } } } },
    });
    assert.equal(fs.readFileSync(outputPath, "utf8"), "previous badge");
    assert.equal(warnings.length, 1);
  });
});

test("incomplete search fails instead of writing a wrong first count", async () => {
  await withBadge(async (outputPath) => {
    await assert.rejects(
      generate({
        outputPath,
        core: { info() {}, warning() {} },
        github: { rest: { search: { issuesAndPullRequests: async () => ({
          data: { total_count: 999, incomplete_results: true },
        }) } } },
      }),
      /Incomplete merged PR search/,
    );
    assert.equal(fs.existsSync(outputPath), false);
  });
});
