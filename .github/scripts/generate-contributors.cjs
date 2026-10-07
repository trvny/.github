const fs = require("node:fs");
const path = require("node:path");

const OWNERS = (process.env.OWNERS || "trvny travnie").trim().split(/\s+/);
const OUTPUT_DIR = path.join("assets", "profile");
const STATE_PATH = path.join(OUTPUT_DIR, "contributors.json");
const SVG_PATH = path.join(OUTPUT_DIR, "contributors.svg");
const COLUMNS = 5;
const AVATAR_SIZE = 72;
const GAP = 18;
const MARGIN = 20;
const TITLE_HEIGHT = 66;
const FOOTER_GAP = 20;

function keyFor(member) {
  return member.id ? `id:${member.id}` : `login:${member.login.toLowerCase()}`;
}

function stableMember(member) {
  return {
    id: member.id || null,
    login: member.login,
    avatarUrl: member.avatarUrl || null,
    profileUrl: member.profileUrl || null,
    type: member.type || "User",
  };
}

function sameMembers(previous, current) {
  if (previous.length !== current.length) return false;
  const currentByKey = new Map(current.map((member) => [keyFor(member), stableMember(member)]));
  return previous.every((member) => {
    const next = currentByKey.get(keyFor(member));
    return next && JSON.stringify(stableMember(member)) === JSON.stringify(next);
  });
}

function escapeXml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

async function listRepositories(github) {
  const repositories = [];

  for (const owner of OWNERS) {
    const { data: account } = await github.rest.users.getByUsername({
      username: owner,
    });
    const owned =
      account.type === "Organization"
        ? await github.paginate(github.rest.repos.listForOrg, {
            org: owner,
            type: "public",
            sort: "full_name",
            direction: "asc",
            per_page: 100,
          })
        : await github.paginate(github.rest.repos.listForUser, {
            username: owner,
            type: "owner",
            sort: "full_name",
            direction: "asc",
            per_page: 100,
          });
    repositories.push(...owned);
  }

  return [...new Map(repositories.map((repo) => [repo.full_name, repo])).values()]
    .filter((repo) => OWNERS.includes(repo.owner.login))
    .filter((repo) => !repo.private && !repo.archived && !repo.disabled && !repo.fork)
    .sort((left, right) => left.full_name.localeCompare(right.full_name));
}

async function listContributors(github, repo) {
  try {
    return await github.paginate(github.rest.repos.listContributors, {
      owner: repo.owner.login,
      repo: repo.name,
      anon: "0",
      per_page: 100,
    });
  } catch (error) {
    if (error?.status === 204 || error?.status === 409) return [];
    throw error;
  }
}

async function avatarDataUri(avatarUrl) {
  if (!avatarUrl) return null;

  const url = new URL(avatarUrl);
  url.searchParams.set("s", "144");

  const response = await fetch(url, {
    headers: { "User-Agent": "trvny-contributors-card" },
  });
  if (!response.ok) return null;

  const mime = (response.headers.get("content-type") || "").split(";")[0].trim();
  if (!["image/png", "image/jpeg", "image/webp", "image/gif"].includes(mime)) return null;

  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length > 1024 * 1024) return null;
  return `data:${mime};base64,${bytes.toString("base64")}`;
}

function readState() {
  if (!fs.existsSync(STATE_PATH)) return { version: 1, members: [] };
  try {
    const parsed = JSON.parse(fs.readFileSync(STATE_PATH, "utf8"));
    if (parsed?.version === 1 && Array.isArray(parsed.members)) return parsed;
  } catch {
    // Bad state -> rebuild.
  }
  return { version: 1, members: [] };
}

function buildSvg(members, avatars) {
  const rows = Math.max(1, Math.ceil(members.length / COLUMNS));
  const width = MARGIN * 2 + COLUMNS * AVATAR_SIZE + (COLUMNS - 1) * GAP;
  const height =
    TITLE_HEIGHT +
    rows * AVATAR_SIZE +
    Math.max(0, rows - 1) * GAP +
    FOOTER_GAP;

  const countText = String(members.length);
  const countWidth = 42 + Math.max(0, countText.length - 1) * 12;
  const countX = MARGIN + 202;

  const defs = members.map((_, index) => {
    const col = index % COLUMNS;
    const row = Math.floor(index / COLUMNS);
    const x = MARGIN + col * (AVATAR_SIZE + GAP);
    const y = TITLE_HEIGHT + row * (AVATAR_SIZE + GAP);
    const cx = x + AVATAR_SIZE / 2;
    const cy = y + AVATAR_SIZE / 2;
    return `<clipPath id="avatar-${index}"><circle cx="${cx}" cy="${cy}" r="${AVATAR_SIZE / 2 - 3}"/></clipPath>`;
  }).join("");

  const nodes = members.map((member, index) => {
    const col = index % COLUMNS;
    const row = Math.floor(index / COLUMNS);
    const x = MARGIN + col * (AVATAR_SIZE + GAP);
    const y = TITLE_HEIGHT + row * (AVATAR_SIZE + GAP);
    const cx = x + AVATAR_SIZE / 2;
    const cy = y + AVATAR_SIZE / 2;
    const avatar = avatars[index];
    const title = escapeXml(member.login);

    const image = avatar
      ? `<image href="${avatar}" x="${x + 3}" y="${y + 3}" width="${AVATAR_SIZE - 6}" height="${AVATAR_SIZE - 6}" preserveAspectRatio="xMidYMid slice" clip-path="url(#avatar-${index})"/>`
      : `<circle class="fallback" cx="${cx}" cy="${cy}" r="${AVATAR_SIZE / 2 - 3}"/><text class="initial" x="${cx}" y="${cy + 7}" text-anchor="middle">${escapeXml(member.login.slice(0, 2).toUpperCase())}</text>`;

    return `<g><title>${title}</title><circle class="ring" cx="${cx}" cy="${cy}" r="${AVATAR_SIZE / 2 - 1}"/>${image}</g>`;
  }).join("");

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-labelledby="title desc">
<title id="title">Contributors</title>
<desc id="desc">${members.length} unique contributors across public non-fork trvny and travnie repositories.</desc>
<style>
  .bg { fill: #ffffff; stroke: #d0d7de; }
  .heading { fill: #1f2328; font: 700 28px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
  .count-bg { fill: #eaeef2; }
  .count { fill: #57606a; font: 700 24px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
  .ring { fill: #f6f8fa; stroke: #d0d7de; stroke-width: 3; }
  .fallback { fill: #eaeef2; }
  .initial { fill: #57606a; font: 700 18px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
  @media (prefers-color-scheme: dark) {
    .bg { fill: #0d1117; stroke: #30363d; }
    .heading { fill: #e6edf3; }
    .count-bg { fill: #21262d; }
    .count { fill: #8c959f; }
    .ring { fill: #161b22; stroke: #30363d; }
    .fallback { fill: #21262d; }
    .initial { fill: #8c959f; }
  }
</style>
<rect class="bg" x="1.5" y="1.5" width="${width - 3}" height="${height - 3}" rx="16"/>
<text class="heading" x="${MARGIN}" y="40">Contributors</text>
<rect class="count-bg" x="${countX}" y="14" width="${countWidth}" height="36" rx="18"/>
<text class="count" x="${countX + countWidth / 2}" y="40" text-anchor="middle">${countText}</text>
<defs>${defs}</defs>
${nodes}
</svg>
`;
}

module.exports = async ({ github, core }) => {
  const force = process.env.FORCE_CONTRIBUTORS === "true";
  const repositories = await listRepositories(github);
  const aggregate = new Map();

  for (const repo of repositories) {
    const contributors = await listContributors(github, repo);
    for (const contributor of contributors) {
      if (!contributor?.login) continue;

      const member = {
        id: contributor.id || null,
        login: contributor.login,
        avatarUrl: contributor.avatar_url || null,
        profileUrl: contributor.html_url || `https://github.com/${contributor.login}`,
        type: contributor.type || "User",
        contributions: Number(contributor.contributions) || 0,
      };
      const key = keyFor(member);
      const previous = aggregate.get(key);
      if (previous) {
        previous.contributions += member.contributions;
      } else {
        aggregate.set(key, member);
      }
    }
  }

  const previousState = readState();
  const previousKeys = new Set(previousState.members.map(keyFor));
  const currentKeys = new Set(aggregate.keys());
  const currentMembers = [...aggregate.values()].map(({ contributions, ...member }) => member);
  const outputsExist = fs.existsSync(STATE_PATH) && fs.existsSync(SVG_PATH);

  if (!force && outputsExist && sameMembers(previousState.members, currentMembers)) {
    core.info(`Contributor roster unchanged: ${currentKeys.size} unique members.`);
    return;
  }

  const previousOrder = previousState.members
    .map(keyFor)
    .filter((key) => aggregate.has(key));
  const previousOrderSet = new Set(previousOrder);
  const newcomers = [...aggregate.entries()]
    .filter(([key]) => !previousOrderSet.has(key))
    .sort(([, left], [, right]) =>
      right.contributions - left.contributions || left.login.localeCompare(right.login),
    )
    .map(([key]) => key);

  const orderedKeys = previousOrder.length
    ? [...previousOrder, ...newcomers]
    : [...aggregate.entries()]
        .sort(([, left], [, right]) =>
          right.contributions - left.contributions || left.login.localeCompare(right.login),
        )
        .map(([key]) => key);

  const members = orderedKeys.map((key) => {
    const { contributions, ...member } = aggregate.get(key);
    return member;
  });

  const avatars = [];
  for (const member of members) {
    try {
      avatars.push(await avatarDataUri(member.avatarUrl));
    } catch (error) {
      core.warning(`Avatar fetch failed for ${member.login}: ${error.message}`);
      avatars.push(null);
    }
  }

  fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  fs.writeFileSync(
    STATE_PATH,
    `${JSON.stringify({ version: 1, members }, null, 2)}\n`,
    "utf8",
  );
  fs.writeFileSync(SVG_PATH, buildSvg(members, avatars), "utf8");

  const added = [...currentKeys].filter((key) => !previousKeys.has(key)).length;
  const removed = [...previousKeys].filter((key) => !currentKeys.has(key)).length;
  core.notice(
    `Contributor roster updated: ${members.length} total, +${added}, -${removed}. ` +
    `Scanned ${repositories.length} public non-fork repositories.`,
  );
};
