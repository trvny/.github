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
  const profileUrl = member.profileUrl?.replace(/\/+$/, "").toLowerCase();
  return profileUrl
    ? `profile:${profileUrl}`
    : `login:${member.login.toLowerCase()}`;
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

function normalizeActor(actor) {
  if (!actor?.login) return null;
  return {
    id: actor.id || null,
    login: actor.login,
    avatarUrl: actor.avatar_url || actor.avatarUrl || null,
    profileUrl: actor.html_url || actor.url || `https://github.com/${actor.login}`,
    type: actor.type || actor.__typename || "User",
  };
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

async function pullRequestReviewPages(github, pullId, cursor) {
  const data = await github.graphql(
    `query($id: ID!, $cursor: String) {
      node(id: $id) {
        ... on PullRequest {
          reviews(first: 100, after: $cursor) {
            nodes {
              author {
                login
                avatarUrl
                url
                __typename
              }
            }
            pageInfo {
              hasNextPage
              endCursor
            }
          }
        }
      }
    }`,
    { id: pullId, cursor },
  );

  return data.node?.reviews;
}

async function collectPullRequestActors(github, repo, addActor) {
  let cursor = null;

  do {
    const data = await github.graphql(
      `query($owner: String!, $name: String!, $cursor: String) {
        repository(owner: $owner, name: $name) {
          pullRequests(
            first: 100
            after: $cursor
            states: [OPEN, CLOSED, MERGED]
            orderBy: { field: CREATED_AT, direction: DESC }
          ) {
            nodes {
              id
              author {
                login
                avatarUrl
                url
                __typename
              }
              reviews(first: 100) {
                nodes {
                  author {
                    login
                    avatarUrl
                    url
                    __typename
                  }
                }
                pageInfo {
                  hasNextPage
                  endCursor
                }
              }
            }
            pageInfo {
              hasNextPage
              endCursor
            }
          }
        }
      }`,
      {
        owner: repo.owner.login,
        name: repo.name,
        cursor,
      },
    );

    const page = data.repository?.pullRequests;
    if (!page) break;

    for (const pull of page.nodes) {
      addActor(pull.author, 2);
      for (const review of pull.reviews.nodes) addActor(review.author, 1);

      let reviewCursor = pull.reviews.pageInfo.hasNextPage
        ? pull.reviews.pageInfo.endCursor
        : null;
      while (reviewCursor) {
        const reviews = await pullRequestReviewPages(github, pull.id, reviewCursor);
        if (!reviews) break;
        for (const review of reviews.nodes) addActor(review.author, 1);
        reviewCursor = reviews.pageInfo.hasNextPage ? reviews.pageInfo.endCursor : null;
      }
    }

    cursor = page.pageInfo.hasNextPage ? page.pageInfo.endCursor : null;
  } while (cursor);
}

async function discussionReplyPages(github, commentId, cursor) {
  const data = await github.graphql(
    `query($id: ID!, $cursor: String) {
      node(id: $id) {
        ... on DiscussionComment {
          replies(first: 50, after: $cursor) {
            nodes {
              author {
                login
                avatarUrl
                url
                __typename
              }
            }
            pageInfo {
              hasNextPage
              endCursor
            }
          }
        }
      }
    }`,
    { id: commentId, cursor },
  );

  const page = data.node?.replies;
  if (!page) throw new Error(`Missing replies page for discussion comment ${commentId}`);
  return page;
}

async function addDiscussionCommentPage(github, comments, addActor) {
  for (const comment of comments.nodes) {
    addActor(comment.author, 1);
    for (const reply of comment.replies.nodes) addActor(reply.author, 1);

    let replyCursor = comment.replies.pageInfo.hasNextPage
      ? comment.replies.pageInfo.endCursor
      : null;
    while (replyCursor) {
      const replies = await discussionReplyPages(github, comment.id, replyCursor);
      for (const reply of replies.nodes) addActor(reply.author, 1);
      replyCursor = replies.pageInfo.hasNextPage ? replies.pageInfo.endCursor : null;
    }
  }
}

async function discussionCommentPages(github, discussionId, cursor) {
  const data = await github.graphql(
    `query($id: ID!, $cursor: String) {
      node(id: $id) {
        ... on Discussion {
          comments(first: 50, after: $cursor) {
            nodes {
              id
              author {
                login
                avatarUrl
                url
                __typename
              }
              replies(first: 50) {
                nodes {
                  author {
                    login
                    avatarUrl
                    url
                    __typename
                  }
                }
                pageInfo {
                  hasNextPage
                  endCursor
                }
              }
            }
            pageInfo {
              hasNextPage
              endCursor
            }
          }
        }
      }
    }`,
    { id: discussionId, cursor },
  );

  const page = data.node?.comments;
  if (!page) throw new Error(`Missing comments page for discussion ${discussionId}`);
  return page;
}

async function collectDiscussionActors(github, repo, addActor) {
  let cursor = null;

  do {
    const data = await github.graphql(
      `query($owner: String!, $name: String!, $cursor: String) {
        repository(owner: $owner, name: $name) {
          discussions(first: 25, after: $cursor) {
            nodes {
              id
              author {
                login
                avatarUrl
                url
                __typename
              }
              comments(first: 50) {
                nodes {
                  id
                  author {
                    login
                    avatarUrl
                    url
                    __typename
                  }
                  replies(first: 50) {
                    nodes {
                      author {
                        login
                        avatarUrl
                        url
                        __typename
                      }
                    }
                    pageInfo {
                      hasNextPage
                      endCursor
                    }
                  }
                }
                pageInfo {
                  hasNextPage
                  endCursor
                }
              }
            }
            pageInfo {
              hasNextPage
              endCursor
            }
          }
        }
      }`,
      {
        owner: repo.owner.login,
        name: repo.name,
        cursor,
      },
    );

    const page = data.repository?.discussions;
    if (!page) throw new Error(`Missing discussions page for ${repo.full_name}`);

    for (const discussion of page.nodes) {
      addActor(discussion.author, 2);
      await addDiscussionCommentPage(github, discussion.comments, addActor);

      let commentCursor = discussion.comments.pageInfo.hasNextPage
        ? discussion.comments.pageInfo.endCursor
        : null;
      while (commentCursor) {
        const comments = await discussionCommentPages(
          github,
          discussion.id,
          commentCursor,
        );
        await addDiscussionCommentPage(github, comments, addActor);
        commentCursor = comments.pageInfo.hasNextPage
          ? comments.pageInfo.endCursor
          : null;
      }
    }

    cursor = page.pageInfo.hasNextPage ? page.pageInfo.endCursor : null;
  } while (cursor);
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
<desc id="desc">${members.length} unique contributors from commits, pull requests, reviews, and discussions across public non-fork trvny and travnie repositories.</desc>
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

  const addActor = (actor, score = 1) => {
    const member = normalizeActor(actor);
    if (!member) return;

    const key = keyFor(member);
    const previous = aggregate.get(key);
    if (previous) {
      previous.score += score;
      if (!previous.id && member.id) previous.id = member.id;
      if (member.avatarUrl) previous.avatarUrl = member.avatarUrl;
      if (member.profileUrl) previous.profileUrl = member.profileUrl;
      if (member.type) previous.type = member.type;
      return;
    }

    aggregate.set(key, { ...member, score });
  };

  for (const repo of repositories) {
    const contributors = await listContributors(github, repo);
    for (const contributor of contributors) {
      addActor(contributor, Number(contributor.contributions) || 1);
    }

    await collectPullRequestActors(github, repo, addActor);
    await collectDiscussionActors(github, repo, addActor);
  }

  const previousState = readState();
  const previousKeys = new Set(previousState.members.map(keyFor));
  const currentKeys = new Set(aggregate.keys());
  const currentMembers = [...aggregate.values()].map(({ score, ...member }) => member);
  const outputsExist = fs.existsSync(STATE_PATH) && fs.existsSync(SVG_PATH);

  if (!force && outputsExist && sameMembers(previousState.members, currentMembers)) {
    core.info(`Contributor roster unchanged: ${currentKeys.size} unique members.`);
    return;
  }

  const previousOrder = [...new Set(
    previousState.members
      .map(keyFor)
      .filter((key) => aggregate.has(key)),
  )];
  const previousOrderSet = new Set(previousOrder);
  const newcomers = [...aggregate.entries()]
    .filter(([key]) => !previousOrderSet.has(key))
    .sort(([, left], [, right]) =>
      right.score - left.score || left.login.localeCompare(right.login),
    )
    .map(([key]) => key);

  const orderedKeys = previousOrder.length
    ? [...previousOrder, ...newcomers]
    : [...aggregate.entries()]
        .sort(([, left], [, right]) =>
          right.score - left.score || left.login.localeCompare(right.login),
        )
        .map(([key]) => key);

  const members = orderedKeys.map((key) => {
    const { score, ...member } = aggregate.get(key);
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
