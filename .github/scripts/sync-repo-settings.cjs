const headers = { "X-GitHub-Api-Version": "2026-03-10" };
const copilotName = "Copilot review for default branch";

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

// Copilot review is off: auto-review on every push ran as the owner (user-to-server
// token) and ate the shared 5000/h REST quota. Never create; strip/disable existing.
async function syncCopilot({ github, core, dryRun, repository, owner, repo }) {
  const list = await github.request("GET /repos/{owner}/{repo}/rulesets", {
    owner,
    repo,
    includes_parents: false,
    per_page: 100,
    headers,
  });

  for (const { id } of list.data.filter(({ name }) => name === copilotName)) {
    const current = await github.request(
      "GET /repos/{owner}/{repo}/rulesets/{ruleset_id}",
      { owner, repo, ruleset_id: id, headers },
    );
    const existingRules = current.data.rules || [];
    const otherRules = existingRules.filter(
      ({ type }) => type !== "copilot_code_review",
    );
    const hasCopilot = otherRules.length !== existingRules.length;
    // Copilot-only ruleset: disable, keep it for an easy re-enable.
    // Mixed ruleset: drop just the Copilot rule, keep deletion/force-push guards.
    const enforcement = otherRules.length === 0 ? "disabled" : current.data.enforcement;
    if (!hasCopilot && enforcement === current.data.enforcement) continue;
    if (otherRules.length === 0 && current.data.enforcement === "disabled") continue;

    await change(
      core,
      dryRun,
      repository,
      "turn off Copilot review",
      () => github.request("PUT /repos/{owner}/{repo}/rulesets/{ruleset_id}", {
        owner,
        repo,
        ruleset_id: id,
        name: current.data.name,
        target: current.data.target,
        enforcement,
        bypass_actors: bypassActors(current.data),
        conditions: current.data.conditions,
        rules: otherRules.length === 0 ? existingRules : otherRules,
        headers,
      }),
    );
  }
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
