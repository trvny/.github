const fs = require("fs");

// Canonical sources in trvny/.ai; downstream copies get overwritten.
const targets = {
  "trvny/trvny": [
    ".github/copilot-instructions.md",
    ".github/instructions/cloudflare.instructions.md",
    ".github/instructions/microsoft.instructions.md",
  ],
  "travnie/Kanarek": [".github/copilot-instructions.md"],
};

module.exports = async ({ github, core }) => {
  const ownerFilter = process.env.TARGET_OWNER;
  const repositoryFilter = process.env.TARGET_REPOSITORY;
  const dryRun = process.env.DRY_RUN === "true";
  const root = fs.realpathSync("ai");

  const read = (path) => {
    const src = `ai/${path}`;
    const real = fs.realpathSync(src);
    // No symlinks: GH_PAT exposed to this process.
    if (fs.lstatSync(src).isSymbolicLink() || !real.startsWith(`${root}/`)) {
      throw new Error(`${path}: symlink or outside trvny/.ai, refusing`);
    }
    return fs.readFileSync(real, "utf8");
  };

  for (const [full, paths] of Object.entries(targets)) {
    const [owner, repo] = full.split("/");
    if (owner !== ownerFilter || (repositoryFilter !== "all" && full !== repositoryFilter)) {
      continue;
    }

    for (const path of paths) {
      const want = read(path);
      let sha;
      try {
        const { data } = await github.rest.repos.getContent({ owner, repo, path });
        if (Buffer.from(data.content, "base64").toString("utf8") === want) {
          core.info(`${full}:${path} up to date`);
          continue;
        }
        sha = data.sha;
      } catch (error) {
        if (error.status !== 404) throw error;
      }

      if (dryRun) {
        core.notice(`${full}:${path} would update`);
        continue;
      }

      await github.rest.repos.createOrUpdateFileContents({
        owner,
        repo,
        path,
        sha,
        message: `chore: sync ${path} from trvny/.ai`,
        content: Buffer.from(want).toString("base64"),
      });
      core.notice(`${full}:${path} updated`);
    }
  }
};
