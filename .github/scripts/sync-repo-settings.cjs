const headers = { "X-GitHub-Api-Version": "2026-03-10" };
const copilotName = "Copilot review for default branch";
const copilotRule = {
  type: "copilot_code_review",
  parameters: { review_draft_pull_requests: false, review_on_push: true },
};

async function change(core, dryRun, repository, label, fn) {
  if (dryRun) {
    core.info(`Would ${label} for ${repository}`);
    return;
  }
  await fn();
  core.info(`Updated ${label} for ${repository}`);
}

function bypassActors(ruleset) {
  return (ruleset.bypass_actors || []).map(
    ({ actor_id, actor_type, bypass_mode }) => ({
      actor_id,
      actor_type,
      bypass_mode,
    }),
  );
}

function defaultBranchOnly(ruleset) {
  const ref = ruleset.conditions?.ref_name;
  return (
    Array.isArray(ref?.include) &&
    ref.include.length === 1 &&
    ref.include[0] === "~DEFAULT_BRANCH" &&
    Array.isArray(ref.exclude) &&
    ref.exclude.length === 0
  );
}

async function syncCopilot({ github, core, dryRun, repository, owner, repo }) {
  const list = await github.request("GET /repos/{owner}/{repo}/rulesets", {
    owner,
    repo,
    includes_parents: false,
    per_page: 100,
    headers,
  });
  const matches = list.data.filter(({ name }) => name === copilotName);
  if (matches.length > 1) {
    throw new Error(`Multiple "${copilotName}" rulesets already exist`);
  }

  if (matches.length === 0) {
    await change(
      core,
      dryRun,
      repository,
      "enable Copilot review on the default branch and on each push",
      () => github.request("POST /repos/{owner}/{repo}/rulesets", {
        owner,
        repo,
        name: copilotName,
        target: "branch",
        enforcement: "active",
        bypass_actors: [],
        conditions: {
          ref_name: { include: ["~DEFAULT_BRANCH"], exclude: [] },
        },
        rules: [copilotRule],
        headers,
      }),
    );
    return;
  }

  const current = await github.request(
    "GET /repos/{owner}/{repo}/rulesets/{ruleset_id}",
    { owner, repo, ruleset_id: matches[0].id, headers },
  );
  if (current.data.target !== "branch" || !defaultBranchOnly(current.data)) {
    throw new Error(
      `Refusing to replace "${copilotName}" because its target or branch conditions differ`,
    );
  }

  const existingRules = current.data.rules || [];
  const existingRule = existingRules.find(
    ({ type }) => type === "copilot_code_review",
  );
  const otherRules = existingRules.filter(
    ({ type }) => type !== "copilot_code_review",
  );
  const ruleMatches =
    existingRule?.parameters?.review_draft_pull_requests === false &&
    existingRule?.parameters?.review_on_push === true;
  if (current.data.enforcement === "active" && ruleMatches) return;
  if (current.data.enforcement !== "active" && otherRules.length > 0) {
    throw new Error(
      `Refusing to activate "${copilotName}" because it contains unrelated rules`,
    );
  }

  const rules = [...otherRules, copilotRule];

  await change(
    core,
    dryRun,
    repository,
    "enable Copilot review on the default branch and on each push",
    () => github.request("PUT /repos/{owner}/{repo}/rulesets/{ruleset_id}", {
      owner,
      repo,
      ruleset_id: current.data.id,
      name: current.data.name,
      target: current.data.target,
      enforcement: "active",
      bypass_actors: bypassActors(current.data),
      conditions: current.data.conditions,
      rules,
      headers,
    }),
  );
}

async function syncRepository({ github, core, dryRun, repository }) {
  const [owner, repo] = repository.split("/");

  const actions = await github.request(
    "GET /repos/{owner}/{repo}/actions/permissions",
    { owner, repo, headers },
  );
  if (!actions.data.enabled || actions.data.allowed_actions !== "all") {
    await change(
      core,
      dryRun,
      repository,
      "allow all Actions and reusable workflows",
      () => github.request("PUT /repos/{owner}/{repo}/actions/permissions", {
        owner,
        repo,
        enabled: true,
        allowed_actions: "all",
        headers,
      }),
    );
  }

  const workflow = await github.request(
    "GET /repos/{owner}/{repo}/actions/permissions/workflow",
    { owner, repo, headers },
  );
  if (
    workflow.data.default_workflow_permissions !== "write" ||
    !workflow.data.can_approve_pull_request_reviews
  ) {
    await change(
      core,
      dryRun,
      repository,
      "set GITHUB_TOKEN read/write and allow PR creation/approval",
      () => github.request(
        "PUT /repos/{owner}/{repo}/actions/permissions/workflow",
        {
          owner,
          repo,
          default_workflow_permissions: "write",
          can_approve_pull_request_reviews: true,
          headers,
        },
      ),
    );
  }

  const retention = await github.request(
    "GET /repos/{owner}/{repo}/actions/permissions/artifact-and-log-retention",
    { owner, repo, headers },
  );
  if (retention.data.days !== 30) {
    await change(
      core,
      dryRun,
      repository,
      "set check/workflow/status/artifact/log retention to 30 days",
      () => github.request(
        "PUT /repos/{owner}/{repo}/actions/permissions/artifact-and-log-retention",
        { owner, repo, days: 30, headers },
      ),
    );
  }

  await syncCopilot({ github, core, dryRun, repository, owner, repo });

  const data = await github.graphql(
    `query($owner: String!, $name: String!) {
      repository(owner: $owner, name: $name) { id hasDiscussionsEnabled }
    }`,
    { owner, name: repo },
  );
  if (data.repository.hasDiscussionsEnabled) {
    await change(
      core,
      dryRun,
      repository,
      "disable Discussions",
      () => github.graphql(
        `mutation($id: ID!) {
          updateRepository(input: {
            repositoryId: $id
            hasDiscussionsEnabled: false
          }) {
            repository { id }
          }
        }`,
        { id: data.repository.id },
      ),
    );
  }
}

module.exports = async ({ github, core }) => {
  const dryRun = process.env.DRY_RUN === "true";
  const results = JSON.parse(process.env.RESULTS_JSON || "[]");
  const failures = [];

  for (const result of results) {
    if (!result.success) {
      const detail = result.error || result.message || "bulk settings sync failed";
      failures.push(`${result.repository}: ${detail}`);
      core.error(`Bulk settings sync failed for ${result.repository}: ${detail}`);
      continue;
    }

    try {
      await syncRepository({
        github,
        core,
        dryRun,
        repository: result.repository,
      });
    } catch (error) {
      failures.push(`${result.repository}: ${error.message}`);
      core.error(`Settings sync failed for ${result.repository}: ${error.message}`);
    }
  }

  core.info(
    "Dependabot security updates are synced by the bulk settings step. " +
    "The repository-level Grouped security updates toggle has no documented public API; " +
    "use dependabot.yml groups when needed.",
  );

  if (failures.length) {
    core.setFailed(`Repository settings sync failed:\n${failures.join("\n")}`);
  }
};
