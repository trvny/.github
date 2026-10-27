const assert = require('node:assert/strict');
const test = require('node:test');
const { discover, render, patchFromFiles, syncOne } = require('./sync-dependabot.cjs');
const file = (path) => ({ path, type: 'blob' });

test('detect real manifests, ignore dependency caches, collapse Gradle modules', () => {
  const found = discover([
    file('settings.gradle.kts'), file('app/build.gradle.kts'),
    file('backend/package.json'), file('backend/node_modules/other/package.json'),
    file('plugins/smx/uv.lock'), file('plugins/smx/pyproject.toml'),
    file('scripts/requirements.txt'), file('.pre-commit-config.yaml'),
    file('feedboard/src/Core/Core.csproj'),
  ]);
  assert.deepEqual([...found.get('gradle')], ['/']);
  assert.deepEqual([...found.get('npm')], ['/backend']);
  assert.deepEqual([...found.get('uv')], ['/plugins/smx']);
  assert.deepEqual([...found.get('pip')], ['/scripts']);
  assert.deepEqual([...found.get('pre-commit')], ['/']);
  assert.deepEqual([...found.get('nuget')], ['/feedboard/src/Core']);
});

test('always includes Actions and preserves compiler-owned pins', () => {
  const config = render('trvny/trvny', discover([file('mcp/pet-dispatcher/package.json')]));
  assert.match(config, /package-ecosystem: "github-actions"/);
  assert.match(config, /dependency-name: "github\/gh-aw-actions\/\*"/);
  assert.match(config, /dependency-name: "@microsoft\/mxc-sdk"/);
  assert.match(config, /applies-to: "security-updates"/);
});

test('keep Kotlin restrictions and Gradle atomic toolchain grouping', () => {
  const config = render('travnie/aistee', discover([file('settings.gradle.kts')]));
  assert.match(config, /versions:\n\s+- "2\.4\.20"/);
  assert.match(config, /rebase-strategy: "disabled"/);
  assert.match(config, /"com\.google\.devtools\.ksp\*"/);
});

test('group only plugin requirements in twojstar', () => {
  const config = render('travnie/twojstar', discover([
    file('plugins/_shared/requirements.txt'),
    file('plugins/google-dev-kit/requirements.txt'),
    file('spacemolt/smx/requirements.txt'),
  ]));
  assert.match(config, /directories:\n\s+- "\/plugins\/_shared"\n\s+- "\/plugins\/google-dev-kit"/);
  assert.match(config, /plugin-requirements:/);
  assert.match(config, /directory: "\/spacemolt\/smx"/);
});

test('generate replacement and new-file patches for GPTomek', () => {
  const updated = patchFromFiles('old\n', 'new\n');
  assert.match(updated, /--- a\/\.github\/dependabot\.yml\n\+\+\+ b\/\.github\/dependabot\.yml/);
  assert.match(updated, /\n-old\n\+new\n/);
  assert.match(patchFromFiles(null, 'new\n'), /--- \/dev\/null\n\+\+\+ b\/\.github\/dependabot\.yml/);
});

test('scan and file read use the same immutable base SHA', async () => {
  const events = [];
  const github = { rest: {
    repos: {
      getBranch: async () => { events.push('branch'); return { data: { commit: { sha: 'a'.repeat(40) } } }; },
      getContent: async (args) => { events.push('content:' + args.ref); throw Object.assign(new Error('missing'), { status: 404 }); },
    },
    git: { getTree: async (args) => { events.push('tree:' + args.tree_sha); return { data: { truncated: false, tree: [] } }; } },
  } };
  await syncOne({ github, core: { notice: () => {}, info: () => {} }, repo: { owner: { login: 'trvny' }, name: '.ai', full_name: 'trvny/.ai', default_branch: 'main' }, dryRun: true });
  assert.deepEqual(events, ['branch', 'tree:' + 'a'.repeat(40), 'content:' + 'a'.repeat(40)]);
});
