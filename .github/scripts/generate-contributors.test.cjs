const assert = require("node:assert/strict");
const { test } = require("node:test");

const { buildLanguageSvg } = require("./generate-contributors.cjs");

test("language card keeps a real donut and aggregated percentages", () => {
  const svg = buildLanguageSvg([["Kotlin", 50], ["TypeScript", 30], ["Python", 20]]);
  assert.equal((svg.match(/class="donut-segment"/g) || []).length, 3);
  assert.match(svg, /Kotlin 50\.0%/);
  assert.match(svg, /TypeScript 30\.0%/);
  assert.match(svg, /Python 20\.0%/);
  assert.match(svg, /trvny \+ travnie/);
  assert.match(svg, /linearGradient/);
  assert.doesNotMatch(svg, /class="track"/);
});

test("other groups languages beyond the top ten", () => {
  const svg = buildLanguageSvg(Array.from({ length: 12 }, (_, i) => [
    "Language" + i, 12 - i,
  ]));
  assert.equal((svg.match(/class="donut-segment"/g) || []).length, 11);
  assert.match(svg, /Other 3\.8%/);
});

test("empty and untrusted language names render safely", () => {
  const empty = buildLanguageSvg([["Kotlin", 0]]);
  assert.match(empty, /No language data available/);
  assert.doesNotMatch(empty, /class="donut-segment"/);
  const svg = buildLanguageSvg([["<script>&", 3]]);
  assert.match(svg, /&lt;script&gt;&amp;/);
  assert.doesNotMatch(svg, /<script>/);
});

test("pre-aggregated Other stays a single trailing bucket", () => {
  const svg = buildLanguageSvg([["Kotlin", 60], ["TypeScript", 30], ["Other", 10]]);
  assert.equal((svg.match(/Other 10\.0%/g) || []).length, 2);
  assert.equal((svg.match(/class="donut-segment"/g) || []).length, 3);
});

test("donut arc lengths and offsets match each language share", () => {
  const svg = buildLanguageSvg([["Kotlin", 50], ["Python", 30], ["Other", 20]]);
  const arcs = [...svg.matchAll(/class="donut-segment"[^>]*stroke-dasharray="([\d.]+) ([\d.]+)" stroke-dashoffset="(-?[\d.]+)"/g)];
  assert.equal(arcs.length, 3);
  const circumference = 2 * Math.PI * 56;
  let offset = 0;
  for (const [index, arc] of arcs.entries()) {
    const length = Number(arc[1]);
    const gap = Number(arc[2]);
    const dashOffset = Number(arc[3]);
    const share = [0.5, 0.3, 0.2][index];
    assert.ok(Math.abs(length - circumference * share) < 0.001);
    assert.ok(Math.abs(length + gap - circumference) < 0.001);
    assert.ok(Math.abs(dashOffset + offset) < 0.001);
    offset += length;
  }
});
