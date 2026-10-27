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

test('recognize additional ecosystems and Bun lockfiles', () => {
  const found = discover([
    file('site/package.json'), file('site/bun.lock'),
    file('ios/Package.swift'), file('elm/elm.json'), file('hex/mix.exs'),
    file('cli/deno.json'), file('nix/flake.nix'), file('rust/rust-toolchain.toml'),
  ]);
  for (const ecosystem of ['bun', 'swift', 'elm', 'mix', 'deno', 'nix', 'rust-toolchain']) {
    assert.ok(found.has(ecosystem), `${ecosystem} missing`);
  }
  const config = render('trvny/.ai', found);
  assert.match(config, /package-ecosystem: "bun"/);
});

test('Actions major updates stay separate from routine and security updates', () => {
  const config = render('trvny/.ai', new Map());
  assert.match(config, /actions:\n\s+patterns:\n\s+- "\*"\n\s+update-types:\n\s+- "minor"\n\s+- "patch"/);
  assert.match(config, /security:\n\s+applies-to: "security-updates"/);
});

test('empty repos are skipped and empty configs are replaceable', async () => {
  const repo = { owner: { login: 'trvny' }, name: '.ai', full_name: 'trvny/.ai', default_branch: 'main' };
  const errors = () => { throw Object.assign(new Error('empty repo'), { status: 409 }); };
  let notice = '';
  await syncOne({ github: { rest: { repos: { getBranch: errors } } }, core: { notice: (s) => { notice = s; } }, repo, dryRun: true });
  assert.match(notice, /empty repository/);
  const github = { rest: {
    repos: { getBranch: async () => ({ data: { commit: { sha: 'a'.repeat(40) } } }), getContent: async () => ({ data: { content: '', encoding: 'base64' } }) },
    git: { getTree: async () => ({ data: { truncated: false, tree: [] } }) },
  } };
  notice = '';
  await syncOne({ github, core: { notice: (s) => { notice = s; } }, repo, dryRun: true });
  assert.match(notice, /would sync/);
});

test('an already-current sync PR is not duplicated', async () => {
  const repo = { owner: { login: 'trvny' }, name: '.ai', full_name: 'trvny/.ai', default_branch: 'main' };
  const base = 'a'.repeat(40), pending = 'b'.repeat(40);
  const want = render(repo.full_name, new Map());
  let noticed = '';
  const github = {
    rest: {
      repos: {
        getBranch: async () => ({ data: { commit: { sha: base } } }),
        getContent: async ({ ref }) => {
          if (ref === pending) return { data: { content: Buffer.from(want).toString('base64') } };
          throw Object.assign(new Error('no config'), { status: 404 });
        },
      },
      git: { getTree: async () => ({ data: { truncated: false, tree: [] } }) },
      pulls: { list: () => {} },
    },
    paginate: async () => [{ head: { repo: { full_name: repo.full_name }, ref: 'chore/dependabot-sync-example', sha: pending }, number: 4 }],
  };
  await syncOne({ github, core: { info: s => { noticed = s; }, warning: () => {} }, repo, dryRun: false });
  assert.match(noticed, /sync PR #4 already current/);
});

test('stale sync PR is refreshed through a guarded GPTomek patch', async () => {
  const repo = { owner: { login: 'trvny' }, name: '.ai', full_name: 'trvny/.ai', default_branch: 'main' };
  const base = 'a'.repeat(40), pending = 'b'.repeat(40), newSha = 'c'.repeat(40);
  const want = render(repo.full_name, new Map());
  let changed = false, writes = 0, noticed = '';
  const github = {
    rest: {
      repos: {
        getBranch: async ({ branch }) => ({ data: { commit: { sha: branch === 'main' ? base : changed ? newSha : pending } } }),
        getContent: async ({ ref }) => {
          if (ref === base) throw Object.assign(new Error('missing'), { status: 404 });
          return { data: { content: Buffer.from(ref === newSha ? want : 'version: 2\nupdates: []\n').toString('base64') } };
        },
      },
      git: { getTree: async () => ({ data: { truncated: false, tree: [] } }) },
      pulls: { list: () => {} },
    },
    paginate: async () => [{ head: { repo: { full_name: repo.full_name }, ref: 'chore/dependabot-sync-example', sha: pending }, number: 4 }],
  };
  const writer = { rest: {
    issues: { createComment: async ({ body }) => {
      const command = JSON.parse(body.split('\n').slice(1, -1).join('\n'));
      assert.equal(command.op, 'apply_patch');
      assert.equal(command.expectedHeadSha, pending);
      writes += 1;
      changed = true;
    } },
    pulls: { create: async () => { throw new Error('must reuse the pending PR'); } },
  } };
  await syncOne({ github, writer, core: { info: () => {}, notice: s => { noticed = s; }, warning: () => {} }, repo,
    dryRun: false, mayWrite: async () => true, sleep: async () => {} });
  assert.equal(writes, 1);
  assert.match(noticed, /refreshed sync PR #4/);
});

test('quota snapshot handles core counters without leaking token data', () => {
  const { quotaSnapshot } = require('./sync-dependabot.cjs');
  const result = quotaSnapshot({ data: { resources: { core: { remaining: 450, limit: 5000, reset: 1793109871 } } }, headers: {} });
  assert.deepEqual(result, { remaining: 450, limit: 5000, reset: 1793109871 });
});

test('public inventory uses Actions token, private inventory uses PAT only when healthy', async () => {
  const { discoverRepositories } = require('./sync-dependabot.cjs');
  const publicGithub = { rest: { repos: { listForUser: () => {}, listForOrg: () => {} } }, paginate: async (_fn, opts) =>
    opts.username ? [{ full_name: 'trvny/trvny', owner: { login: 'trvny' } }] : [{ full_name: 'travnie/aistee', owner: { login: 'travnie' } }] };
  let privateRequests = 0;
  const pat = { rest: { repos: { listForAuthenticatedUser: () => {} } }, paginate: async (_fn, options) => {
    assert.equal(options.visibility, 'private');
    assert.equal(options.affiliation, 'owner,organization_member,collaborator');
    privateRequests += 1;
    return [{ full_name: 'travnie/private', owner: { login: 'travnie' }, private: true }];
  } };
  const core = { warning: () => {} };
  const publicOnly = await discoverRepositories({ publicGithub, pat, patAvailable: false, core });
  assert.deepEqual(publicOnly.map(r => r.full_name), ['trvny/trvny', 'travnie/aistee']);
  assert.equal(privateRequests, 0);
  const withPrivate = await discoverRepositories({ publicGithub, pat, patAvailable: true, core });
  assert.deepEqual(withPrivate.map(r => r.full_name), ['trvny/trvny', 'travnie/aistee', 'travnie/private']);
  assert.equal(privateRequests, 1);
});

test('stop PAT mutations when the remaining quota changes mid-sync', async () => {
  const repo = { owner: { login: 'trvny' }, name: '.ai', full_name: 'trvny/.ai', default_branch: 'main' };
  const sha = 'a'.repeat(40);
  const calls = [];
  const github = {
    rest: {
      repos: {
        getBranch: async ({ branch }) => {
          if (branch !== 'main') throw Object.assign(new Error('no branch'), { status: 404 });
          return { data: { commit: { sha } } };
        },
        getContent: async () => { throw Object.assign(new Error('missing'), { status: 404 }); },
      },
      git: { getTree: async () => ({ data: { truncated: false, tree: [] } }) },
      pulls: { list: () => {} },
    },
    paginate: async () => [],
  };
  const writer = { rest: {
    issues: { createComment: async () => { calls.push('comment'); } },
    pulls: { create: async () => { calls.push('PR'); } },
  } };
  let quotaChecks = 0;
  const mayWrite = async () => ++quotaChecks === 1;
  const warnings = [];
  await syncOne({ github, writer, core: { warning: s => warnings.push(s), notice: () => {} },
    repo, dryRun: false, mayWrite });
  assert.deepEqual(calls, []);
  assert.ok(warnings.some(s => s.includes('deferring GPTomek')));
});

test('security major updates remain individual; tooling configs do not count as pip manifests', () => {
  const found = discover([file('.github/linters/pyproject.toml'), file('pyproject.toml')]);
  assert.deepEqual([...found.get('pip')], ['/']);
  const config = render('trvny/feedseek', found);
  assert.match(config, /security:\n\s+applies-to: "security-updates"[\s\S]*?update-types:\n\s+- "minor"\n\s+- "patch"/);
  assert.doesNotMatch(config, /directory: "\/.github\/linters"/);
});

test('npm workspaces under twojstar benches use the root lockfile', () => {
  const config = render('travnie/twojstar', discover([
    file('benches/package.json'), file('benches/package-lock.json'),
    file('benches/codebench/package.json'), file('benches/docbench/package.json'),
    file('benches/streambench/package.json'), file('weather-feed/package.json'),
  ]));
  assert.match(config, /directory: "\/benches"/);
  assert.match(config, /directory: "\/weather-feed"/);
  assert.doesNotMatch(config, /directory: "\/benches\/(?:codebench|docbench|streambench)"/);
});
