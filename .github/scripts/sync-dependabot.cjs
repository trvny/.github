const { spawnSync } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const OWNERS = new Set(['trvny', 'travnie']);
const PAT_WRITE_RESERVE = 250;

// Public reads use the per-repository Actions token. PAT only for private repos and writes.
function quotaSnapshot(response) {
  const core = response?.data?.resources?.core;
  const headers = response?.headers || {};
  const remaining = Number(headers['x-ratelimit-remaining']);
  const reset = Number(headers['x-ratelimit-reset']);
  return {
    remaining: core && Number.isFinite(core.remaining) ? core.remaining : (Number.isFinite(remaining) ? remaining : null),
    limit: core && Number.isFinite(core.limit) ? core.limit : null,
    reset: core && Number.isFinite(core.reset) ? core.reset : (Number.isFinite(reset) ? reset : null),
  };
}

async function getQuota(client, core) {
  try {
    return quotaSnapshot(await client.rest.rateLimit.get());
  } catch (error) {
    core.warning(`Cannot read PAT quota: ${error.message}`);
    return { remaining: null, limit: null, reset: null };
  }
}

function quotaLabel(q) {
  const reset = q.reset ? new Date(q.reset * 1000).toISOString() : 'unknown';
  return `${q.remaining ?? 'unknown'}/${q.limit ?? 'unknown'} remaining; reset ${reset}`;
}

function countRequests(client) {
  const counts = new Map();
  if (client?.hook?.after) {
    client.hook.after('request', (_response, options) => {
      const route = `${options.method || 'GET'} ${String(options.url || '').split('?')[0]}`;
      if (route.endsWith(' /rate_limit')) return;
      counts.set(route, (counts.get(route) || 0) + 1);
    });
  }
  return counts;
}

async function discoverRepositories({ publicGithub, pat, patAvailable, core }) {
  const publicLists = await Promise.all([
    publicGithub.paginate(publicGithub.rest.repos.listForUser, { username: 'trvny', type: 'owner', per_page: 100 }),
    publicGithub.paginate(publicGithub.rest.repos.listForOrg, { org: 'travnie', type: 'public', per_page: 100 }),
  ]);
  const repositories = publicLists.flat();
  if (patAvailable) {
    try {
      const privateVisible = await pat.paginate(pat.rest.repos.listForAuthenticatedUser, {
        affiliation: 'owner,organization_member,collaborator', visibility: 'private', per_page: 100,
      });
      repositories.push(...privateVisible);
    } catch (error) {
      core.warning(`Private repository inventory unavailable: ${error.message}`);
      core.warning('Private repositories deferred; public scan continues.');
    }
  } else {
    core.warning('PAT quota unavailable/low: private repository inventory deferred.');
  }
  return [...new Map(repositories.map(repo => [repo.full_name, repo])).values()]
    .filter(repo => OWNERS.has(repo.owner.login) && !repo.archived && !repo.disabled);
}

const TARGET = '.github/dependabot.yml';
const MAILBOX = { owner: 'trvny', repo: 'trvny', issue_number: 203 };
const BRANCH_PREFIX = 'chore/dependabot-sync-';
const SCHEDULE = { interval: 'weekly', day: 'monday', time: '21:37', timezone: 'Europe/Warsaw' };

// Overrides only where shared rules would alter intentional repo behavior.
const OVERRIDES = {
  'trvny/trvny': {
    'github-actions@/': {
      ignore: [{ 'dependency-name': 'github/gh-aw-actions/*' }],
    },
    'npm@/mcp/pet-dispatcher': {
      ignore: [{ 'dependency-name': '@microsoft/mxc-sdk', 'update-types': ['version-update:semver-major'] }],
    },
  },
  'travnie/Autka': {
    'gradle@/': {
      'open-pull-requests-limit': 15,
      'rebase-strategy': 'disabled',
      groups: {
        androidx: { patterns: ['androidx.*'] },
        kotlin: { patterns: ['org.jetbrains.kotlin*', 'com.google.devtools.ksp*'] },
        routine: { patterns: ['*'], 'update-types': ['minor', 'patch'] },
        security: { 'applies-to': 'security-updates', patterns: ['*'], 'update-types': ['minor', 'patch'] },
      },
    },
    'npm@/backend': { 'open-pull-requests-limit': 10, 'commit-message': { prefix: 'deps(backend)' } },
  },
  'travnie/aistee': {
    'gradle@/': {
      'open-pull-requests-limit': 10,
      'rebase-strategy': 'disabled',
      ignore: [{ 'dependency-name': 'org.jetbrains.kotlin*', versions: ['2.4.20'] }],
      groups: {
        kotlin: { patterns: ['org.jetbrains.kotlin*', 'com.google.devtools.ksp*'] },
        routine: { patterns: ['*'], 'update-types': ['minor', 'patch'] },
        security: { 'applies-to': 'security-updates', patterns: ['*'], 'update-types': ['minor', 'patch'] },
      },
    },
  },
  'travnie/Kanarek': {
    'gradle@/': {
      groups: {
        androidx: { patterns: ['androidx*'] },
        kotlin: { patterns: ['org.jetbrains.kotlin*'] },
        routine: { patterns: ['*'], 'update-types': ['minor', 'patch'] },
        security: { 'applies-to': 'security-updates', patterns: ['*'], 'update-types': ['minor', 'patch'] },
      },
    },
  },
};

const NOISE = new Set(['node_modules', '.venv', 'venv', '.git', 'vendor', 'dist', 'build', '.next', '.turbo', 'coverage', '__pycache__', 'target']);
const dir = (file) => '/' + file.split('/').slice(0, -1).join('/');
const parentDir = (file) => dir(file).replace(/\/$/, '') || '/';
const filename = (file) => file.split('/').at(-1);
const hasAncestor = (directory, roots) => [...roots].some((root) => root === directory || (root === '/' ? true : directory.startsWith(root + '/')));

function discover(entries) {
  const files = entries.filter((entry) => entry.type === 'blob' &&
    !entry.path.startsWith('.github/linters/') &&
    !entry.path.split('/').some((p) => NOISE.has(p) || p.startsWith('.cache')))
    .map((entry) => entry.path);
  const set = new Set(files);
  const found = new Map();
  const add = (ecosystem, directory) => {
    if (!found.has(ecosystem)) found.set(ecosystem, new Set());
    found.get(ecosystem).add(directory);
  };
  const gradleRoots = new Set(files.filter((file) => /^settings\.gradle(?:\.kts)?$/.test(filename(file))).map(parentDir));
  const tofuRoots = new Set(files.filter((file) => file.endsWith('.tofu')).map(parentDir));
  for (const file of files) {
    const name = filename(file);
    const directory = parentDir(file);
    if (name === 'package.json') add(set.has(file.replace(/package\.json$/, 'bun.lock')) || set.has(file.replace(/package\.json$/, 'bun.lockb')) ? 'bun' : 'npm', directory);
    if (name === 'uv.lock') add('uv', directory);
    if (name === 'pyproject.toml' && !set.has(file.replace(/pyproject\.toml$/, 'uv.lock'))) add('pip', directory);
    if (/^requirements(?:[-_.][\w.-]+)?\.txt$/.test(name) || ['Pipfile', 'setup.py', 'setup.cfg'].includes(name)) {
      if (!set.has(file.replace(/[^/]+$/, 'uv.lock'))) add('pip', directory);
    }
    if (/^settings\.gradle(?:\.kts)?$/.test(name)) add('gradle', directory);
    if (/^build\.gradle(?:\.kts)?$/.test(name) && !hasAncestor(directory, gradleRoots)) add('gradle', directory);
    if (/\.(?:csproj|fsproj|vbproj)$/.test(name) || name === 'packages.config') add('nuget', directory);
    if (name === 'go.mod') add('gomod', directory);
    if (name === 'Cargo.toml') add('cargo', directory);
    if (name === 'pom.xml') add('maven', directory);
    if (name === 'composer.json') add('composer', directory);
    if (name === 'Gemfile') add('bundler', directory);
    if (name === 'pubspec.yaml') add('pub', directory);
    if (/^Dockerfile(?:\..+)?$/.test(name)) add('docker', directory);
    if (/^(?:docker-)?compose\.ya?ml$/.test(name)) add('docker-compose', directory);
    if (name === '.pre-commit-config.yaml') add('pre-commit', directory);
    if (name === '.terraform.lock.hcl' || name.endsWith('.tf')) add(tofuRoots.has(directory) ? 'opentofu' : 'terraform', directory);
    if (name === 'Chart.yaml') add('helm', directory);
    if (name === 'Package.swift') add('swift', directory);
    if (name === 'elm.json') add('elm', directory);
    if (name === 'mix.exs') add('mix', directory);
    if (name === 'deno.json' || name === 'deno.jsonc') add('deno', directory);
    if (name === 'Project.toml' || name === 'Manifest.toml') add('julia', directory);
    if (name === 'flake.nix') add('nix', directory);
    if (name === 'rust-toolchain.toml' || name === 'rust-toolchain') add('rust-toolchain', directory);
    if (name === 'vcpkg.json') add('vcpkg', directory);
    if (name === 'build.sbt') add('sbt', directory);
    if (name === 'MODULE.bazel' || name === 'WORKSPACE.bazel') add('bazel', directory);
    if (name === 'environment.yml' || name === 'environment.yaml') add('conda', directory);
    if (name.endsWith('.tofu')) add('opentofu', directory);
  }
  if (set.has('.gitmodules')) add('gitsubmodule', '/');
  if (set.has('.devcontainer/devcontainer.json')) add('devcontainers', '/');
  return found;
}

function entriesFor(fullName, found) {
  const actions = {
    'package-ecosystem': 'github-actions', directory: '/', schedule: SCHEDULE,
    'open-pull-requests-limit': 5, 'commit-message': { prefix: 'ci' },
    groups: {
      actions: { patterns: ['*'], 'update-types': ['minor', 'patch'] },
      security: { 'applies-to': 'security-updates', patterns: ['*'], 'update-types': ['minor', 'patch'] },
    },
    ...(OVERRIDES[fullName]?.['github-actions@/'] || {}),
  };
  const updates = [actions];
  const ordered = [...found.keys()].sort();
  for (const ecosystem of ordered) {
    const directories = [...found.get(ecosystem)].sort();
    // npm workspace lockfile at /benches owns its child package manifests.
    if (fullName === 'travnie/twojstar' && ecosystem === 'npm' && directories.includes('/benches')) {
      directories.splice(0, directories.length, ...directories.filter((d) => !d.startsWith('/benches/')));
    }
    // The existing four plugin requirements trees belong to one reviewable PR.
    if (fullName === 'travnie/twojstar' && ecosystem === 'pip') {
      const plugins = directories.filter((p) => p.startsWith('/plugins/'));
      if (plugins.length > 0) {
        updates.push(makeEntry(ecosystem, plugins, fullName, 'plugin-requirements'));
        directories.splice(0, directories.length, ...directories.filter((p) => !plugins.includes(p)));
      }
    }
    for (const directory of directories) updates.push(makeEntry(ecosystem, [directory], fullName));
  }
  return updates;
}

function makeEntry(ecosystem, directories, fullName, groupName = 'routine') {
  const single = directories.length === 1;
  const spec = {
    'package-ecosystem': ecosystem,
    [single ? 'directory' : 'directories']: single ? directories[0] : directories,
    schedule: SCHEDULE,
    'open-pull-requests-limit': 8,
    'commit-message': { prefix: 'deps' },
    groups: {
      [groupName]: { patterns: ['*'], 'update-types': ['minor', 'patch'] },
      security: { 'applies-to': 'security-updates', patterns: ['*'], 'update-types': ['minor', 'patch'] },
    },
  };
  const override = OVERRIDES[fullName]?.[`${ecosystem}@${directories[0]}`] || {};
  return { ...spec, ...override };
}

function yamlLines(value, indent = 0, list = false) {
  const pad = ' '.repeat(indent);
  const arr = [];
  const properties = Object.entries(value);
  for (const [index, [key, item]] of properties.entries()) {
    const prefix = pad + (list && index === 0 ? '- ' : list ? '  ' : '');
    const childIndent = indent + (list ? 4 : 2);
    if (Array.isArray(item)) {
      arr.push(`${prefix}${key}:`);
      for (const member of item) {
        if (member !== null && typeof member === 'object') {
          arr.push(...yamlLines(member, childIndent, true));
        } else {
          arr.push(`${' '.repeat(childIndent)}- ${JSON.stringify(member)}`);
        }
      }
    } else if (item !== null && typeof item === 'object') {
      arr.push(`${prefix}${key}:`);
      arr.push(...yamlLines(item, childIndent));
    } else {
      arr.push(`${prefix}${key}: ${JSON.stringify(item)}`);
    }
  }
  return arr;
}

function render(fullName, found) {
  const entries = entriesFor(fullName, found);
  const lines = [
    '# Generated by trvny/.github/.github/scripts/sync-dependabot.cjs.',
    '# Edit the central rules, not this copy.',
    'version: 2',
    'updates:',
  ];
  for (const entry of entries) lines.push(...yamlLines(entry, 2, true));
  return lines.join('\n') + '\n';
}

function patchFromFiles(previous, wanted) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dependabot-sync-'));
  try {
    const left = path.join(tmp, 'before');
    const right = path.join(tmp, 'after');
    fs.writeFileSync(left, previous || '');
    fs.writeFileSync(right, wanted);
    const diff = spawnSync('diff', ['-u', '--label', previous === null ? '/dev/null' : `a/${TARGET}`, '--label', `b/${TARGET}`, left, right], { encoding: 'utf8' });
    if (diff.status !== 1 || !diff.stdout) throw new Error(`diff failed: ${diff.stderr || diff.status}`);
    return `diff --git a/${TARGET} b/${TARGET}\n${diff.stdout}`;
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

async function loadConfig(github, owner, repo, ref) {
  try {
    const { data } = await github.rest.repos.getContent({ owner, repo, path: TARGET, ref });
    if (Array.isArray(data) || typeof data.content !== 'string') throw new Error(`${owner}/${repo}: non-file Dependabot config`);
    return Buffer.from(data.content, 'base64').toString('utf8');
  } catch (error) {
    if (error.status === 404) return null;
    throw error;
  }
}

async function syncOne({ github, core, repo, dryRun, writer = github, mayWrite = async () => true }) {
  const { owner: { login: owner }, name, full_name: fullName, default_branch: base } = repo;
  let branchInfo;
  try {
    ({ data: branchInfo } = await github.rest.repos.getBranch({ owner, repo: name, branch: base }));
  } catch (error) {
    if (error.status === 404 || error.status === 409) return core.notice(`${fullName}: empty repository; skip`);
    throw error;
  }
  const baseSha = branchInfo.commit.sha;
  let tree;
  try {
    ({ data: tree } = await github.rest.git.getTree({ owner, repo: name, tree_sha: baseSha, recursive: 'true' }));
  } catch (error) {
    if (error.status === 409) return core.notice(`${fullName}: empty repository; skip`);
    throw error;
  }
  if (tree.truncated) throw new Error(`${fullName}: git tree truncated; refuse partial manifest scan`);
  const wanted = render(fullName, discover(tree.tree));
  const previous = await loadConfig(github, owner, name, baseSha);
  if (previous === wanted) return core.info(`${fullName}: up to date`);
  if (dryRun) return core.notice(`${fullName}: would sync Dependabot configuration`);
  if (!(await mayWrite())) return core.warning(`${fullName}: PAT quota too low; deferring writes`);

  const prs = await github.paginate(github.rest.pulls.list, { owner, repo: name, state: 'open', per_page: 100 });
  const pending = prs.find((pr) => pr.head.repo?.full_name === fullName && pr.head.ref.startsWith(BRANCH_PREFIX));
  if (pending) {
    const pendingContent = await loadConfig(github, owner, name, pending.head.sha);
    if (pendingContent === wanted) return core.info(`${fullName}: sync PR #${pending.number} already current`);
    if (!(await mayWrite())) return core.warning(`${fullName}: PAT quota low; defer updating sync PR #${pending.number}`);
    const checksum = crypto.createHash('sha256').update(fullName + pending.head.sha + wanted).digest('hex').slice(0, 12);
    const command = {
      id: `dependabot-refresh-${checksum}-${owner}-${name}`.slice(0, 100),
      op: 'apply_patch', repository: fullName, branch: pending.head.ref,
      expectedHeadSha: pending.head.sha,
      message: 'chore(deps): refresh central Dependabot rules',
      patch: patchFromFiles(pendingContent, wanted),
    };
    await writer.rest.issues.createComment({
      ...MAILBOX,
      body: `\`\`\`gptomek\n${JSON.stringify(command)}\n\`\`\``,
    });
    let updatedSha = null;
    for (let attempt = 0; attempt < 30; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 2500));
      const { data } = await github.rest.repos.getBranch({ owner, repo: name, branch: pending.head.ref });
      if (data.commit?.sha !== pending.head.sha) { updatedSha = data.commit.sha; break; }
    }
    if (!updatedSha) throw new Error(`${fullName}: GPTomek did not refresh PR #${pending.number}; inspect trvny/trvny#203`);
    const actual = await loadConfig(github, owner, name, updatedSha);
    if (actual !== wanted) throw new Error(`${fullName}: unexpected content after PR #${pending.number} refresh`);
    return core.notice(`${fullName}: refreshed sync PR #${pending.number}`);
  }
  const checksum = crypto.createHash('sha256').update(fullName + baseSha + wanted).digest('hex').slice(0, 12);
  const branch = `${BRANCH_PREFIX}${checksum}`;

  let exists = false;
  try {
    const { data } = await github.rest.repos.getBranch({ owner, repo: name, branch });
    exists = Boolean(data.commit?.sha);
  } catch (error) {
    if (error.status !== 404) throw error;
  }
  if (exists) {
    const closed = await github.paginate(github.rest.pulls.list, {
      owner, repo: name, state: 'closed', head: `${owner}:${branch}`, per_page: 100,
    });
    if (closed.some((pr) => pr.head.repo?.full_name === fullName && pr.head.ref === branch)) {
      return core.notice(`${fullName}: sync PR for this branch closed; respect closure`);
    }
  }
  if (!exists) {
    if (!(await mayWrite())) return core.warning(`${fullName}: PAT quota too low; deferring GPTomek request`);
    const command = {
      id: `dependabot-sync-${checksum}-${owner}-${name}`.slice(0, 100),
      op: 'branch_from_patch', repository: fullName, branch, baseSha,
      message: 'chore(deps): sync Dependabot rules',
      patch: patchFromFiles(previous, wanted),
    };
    await writer.rest.issues.createComment({
      ...MAILBOX,
      body: `\`\`\`gptomek\n${JSON.stringify(command)}\n\`\`\``,
    });
    // GPTomek runs via the existing Issue #203 relay, not in this job.
    let ready = false;
    for (let attempt = 0; attempt < 30; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 2500));
      try {
        await github.rest.repos.getBranch({ owner, repo: name, branch });
        ready = true;
        break;
      } catch (error) {
        if (error.status !== 404) throw error;
      }
    }
    if (!ready) throw new Error(`${fullName}: GPTomek branch not ready; inspect trvny/trvny#203`);
  }
  const actual = await loadConfig(github, owner, name, branch);
  if (actual !== wanted) throw new Error(`${fullName}: unexpected branch content; refusing PR`);
  if (!(await mayWrite())) return core.warning(`${fullName}: PAT quota too low; deferring pull request`);
  const { data: pr } = await writer.rest.pulls.create({
    owner, repo: name, base, head: branch,
    title: 'chore(deps): sync Dependabot rules',
    body: 'Central rules: [trvny/.github](https://github.com/trvny/.github/blob/main/.github/scripts/sync-dependabot.cjs).\n\nDetected ecosystems, grouped minor/patch and security updates; breaking majors stay separate. Repository-specific exceptions remain central. No automatic merge.',
  });
  core.notice(`${fullName}: opened ${pr.html_url}`);
}

module.exports = async ({ github, core, pat }) => {
  const filter = process.env.TARGET_REPOSITORY?.trim() || '';
  const dryRun = process.env.DRY_RUN === 'true';
  if (filter && !/^(?:trvny|travnie)\/[\w.-]+$/.test(filter)) throw new Error('Invalid repository filter');
  const observedPublic = countRequests(github);
  const observedPat = countRequests(pat);
  const before = pat ? await getQuota(pat, core) : { remaining: null, limit: null, reset: null };
  const patAvailable = Boolean(pat && before.remaining !== null && before.remaining >= PAT_WRITE_RESERVE);
  const failures = [];
  let targets = [];
  try {
    const repositories = await discoverRepositories({ publicGithub: github, pat, patAvailable, core });
    targets = repositories.filter(repo => !filter || repo.full_name === filter);
    if (targets.length === 0) {
      if (filter && !patAvailable) {
        core.warning(`${filter}: target not visible with Actions token, PAT inventory deferred due to quota`);
        return;
      }
      throw new Error('No accessible target repositories');
    }
    const queue = [...targets].sort((a, b) => a.full_name.localeCompare(b.full_name));
    const writable = !dryRun && patAvailable;
    if (!writable && !dryRun) core.warning('PAT writes deferred due to quota; public discovery still runs.');
    await Promise.all(Array.from({ length: Math.min(3, queue.length) }, async () => {
      while (queue.length) {
        const repo = queue.shift();
        try {
          const current = writable ? await getQuota(pat, core) : before;
          const canProceed = writable && current.remaining !== null && current.remaining >= PAT_WRITE_RESERVE;
          if (repo.private && !canProceed) {
            core.warning(`${repo.full_name}: private scan deferred due to PAT quota`);
            continue;
          }
          const reader = repo.private ? pat : github;
          const mayWrite = async () => {
            const q = await getQuota(pat, core);
            return q.remaining !== null && q.remaining >= PAT_WRITE_RESERVE;
          };
          await syncOne({ github: reader, writer: pat || reader, core, repo,
            dryRun: dryRun || !canProceed, mayWrite });
        } catch (error) {
          failures.push(`${repo.full_name}: ${error.message}`);
          core.error(failures.at(-1));
        }
      }
    }));
    if (failures.length) core.setFailed(failures.join('\n'));
  } finally {
    const after = pat ? await getQuota(pat, core) : { remaining: null, limit: null, reset: null };
    const count = values => [...values.values()].reduce((sum, value) => sum + value, 0);
    const measuredPat = count(observedPat);
    const coreUsedDelta = before.remaining !== null && after.remaining !== null
      ? Math.max(0, before.remaining - after.remaining) : null;
    const externalDelta = coreUsedDelta === null ? 'unknown'
      : `rough estimate ${Math.max(0, coreUsedDelta - measuredPat)}`;
    await core.summary
      .addHeading('GitHub API quota diagnostics')
      .addTable([
        [{ data: 'Metric', header: true }, { data: 'Value', header: true }],
        ['Repositories scanned', String(targets.length)],
        ['GITHUB_TOKEN calls observed', String(count(observedPublic))],
        ['GH_PAT calls observed', String(measuredPat)],
        ['GH_PAT before', quotaLabel(before)],
        ['GH_PAT after', quotaLabel(after)],
        ['Shared quota used while running', String(coreUsedDelta ?? 'unknown')],
        ['Usage not accounted for by this workflow', externalDelta],
      ])
      .addRaw('Quota delta is shared across the account. The estimate excludes unobserved failures and some zero-cost endpoints; it is not a lower bound or attribution to another app.')
      .write();
  }
};
module.exports.discover = discover;
module.exports.render = render;
module.exports.patchFromFiles = patchFromFiles;
module.exports.syncOne = syncOne;
module.exports.quotaSnapshot = quotaSnapshot;
module.exports.discoverRepositories = discoverRepositories;
