#!/usr/bin/env python3
"""Post DeepSource findings to one stable GitHub PR comment."""

import json
import os
import re
import sys
from urllib.parse import quote
from urllib.request import Request, urlopen

MARKER = "<!-- deepsource-pr-findings:v1 -->"
MAX_REPORT_BYTES = 50_000
QUERY = """
query ($sha: String!, $after: String) {
  run(commitOid: $sha) {
    runUid
    checks(first: 30, after: $after) {
      pageInfo { hasNextPage endCursor }
      edges {
        node {
          id
          analyzer { name }
          issues(first: 100) {
            totalCount
            pageInfo { hasNextPage endCursor }
            edges {
              node {
                path beginLine severity shortcode title isSuppressed
              }
            }
          }
        }
      }
    }
  }
}
"""

MORE_ISSUES_QUERY = """
query ($check: ID!, $cursor: String) {
  node(id: $check) {
    ... on Check {
      issues(first: 100, after: $cursor) {
        pageInfo { hasNextPage endCursor }
        edges {
          node {
            path beginLine severity shortcode title isSuppressed
          }
        }
      }
    }
  }
}
"""


def get_json(url, token, method="GET", payload=None):
    body = json.dumps(payload).encode() if payload is not None else None
    req = Request(url, data=body, method=method, headers={
        "Authorization": "Bearer " + token,
        "Accept": "application/json",
        "Content-Type": "application/json",
        "User-Agent": "travny-deepsource-pr-reporter",
    })
    with urlopen(req, timeout=25) as response:
        return json.load(response)


def safe_markdown(value):
    special = "\\\x60*_{}[]()#+-.!|<>"
    return "".join("\\" + char if char in special else char for char in str(value))


def format_report(repo, sha, run):
    found = []
    for edge in run["checks"]["edges"]:
        check = edge["node"]
        if not check:
            continue
        for item in check["issues"]["edges"]:
            issue = item["node"]
            if issue and not issue["isSuppressed"]:
                found.append((check["analyzer"]["name"], issue))
    found.sort(key=lambda x: (
        {"CRITICAL": 0, "MAJOR": 1, "MINOR": 2}.get(x[1]["severity"].upper(), 3),
        x[1]["path"], x[1]["beginLine"],
    ))
    lines = [MARKER, "### DeepSource findings: " + sha[:7], "",
             f"{len(found)} actionable findings.", ""]
    footer = ["",
              f"[Full DeepSource analysis](https://app.deepsource.com/gh/{repo}/run/{run['runUid']}/)",
              "", "_Updated automatically from the DeepSource API._"]
    used = len("\n".join(lines + footer).encode("utf-8")) + 256
    shown = 0
    for analyzer, issue in found:
        if shown >= 150:
            break
        path, line = issue["path"], issue["beginLine"]
        title = safe_markdown(" ".join((issue["title"] or "Unnamed issue").split()))
        code = safe_markdown(issue["shortcode"] or "AI")
        link = f"https://github.com/{repo}/blob/{sha}/{quote(path, safe='/')}#L{line}"
        entry = (f"- **{issue['severity'].lower()}** {safe_markdown(analyzer)} "
                 f"[{safe_markdown(path)}:{line}]({link}): {code} · {title}")
        size = len((entry + "\n").encode("utf-8"))
        if used + size > MAX_REPORT_BYTES:
            break
        lines.append(entry)
        used += size
        shown += 1
    if shown < len(found):
        lines.append(f"- {len(found) - shown} additional findings in the full report.")
    return "\n".join(lines + footer), len(found)


def main():
    repo = os.environ["GITHUB_REPOSITORY"]
    sha = os.environ["TARGET_SHA"].strip().lower()
    if not re.fullmatch(r"[0-9a-f]{40}", sha):
        raise ValueError("Full 40-character TARGET_SHA required")
    github_token = os.environ["GITHUB_TOKEN"]
    gh = "https://api.github.com/repos/" + repo
    prs = get_json(f"{gh}/commits/{sha}/pulls?per_page=100", github_token)
    prs = [p for p in prs if p["state"] == "open" and p["head"]["sha"] == sha
           and p["head"]["repo"]["full_name"] == repo]
    if not prs:
        print("No open same-repository PR on this commit")
        return

    run = None
    all_checks = []
    after = None
    for _ in range(100):
        data = get_json("https://api.deepsource.com/graphql/", os.environ["DEEPSOURCE_PAT"],
                        "POST", {"query": QUERY, "variables": {"sha": sha, "after": after}})
        if data.get("errors"):
            raise RuntimeError("DeepSource GraphQL query rejected: " + json.dumps(data["errors"]))
        page = (data.get("data") or {}).get("run")
        if not page:
            raise RuntimeError("No DeepSource run for this SHA")
        if run is None:
            run = page
        all_checks.extend(page["checks"]["edges"])
        info = page["checks"]["pageInfo"]
        if not info["hasNextPage"]:
            break
        after = info["endCursor"]
        if not after:
            raise RuntimeError("Missing DeepSource check pagination cursor")
    else:
        raise RuntimeError("DeepSource check pagination exceeded 100 pages")
    # Follow each check's issue cursor before filtering suppressed findings.
    for edge in all_checks:
        check = edge["node"]
        if not check:
            continue
        issues = check["issues"]
        seen_cursors = set()
        for _ in range(100):
            info = issues["pageInfo"]
            if not info["hasNextPage"]:
                break
            cursor = info["endCursor"]
            if not cursor or cursor in seen_cursors:
                raise RuntimeError("Invalid DeepSource issue pagination cursor")
            seen_cursors.add(cursor)
            data = get_json("https://api.deepsource.com/graphql/",
                            os.environ["DEEPSOURCE_PAT"], "POST",
                            {"query": MORE_ISSUES_QUERY,
                             "variables": {"check": check["id"], "cursor": cursor}})
            if data.get("errors"):
                raise RuntimeError("DeepSource issues query rejected: " + json.dumps(data["errors"]))
            node = (data.get("data") or {}).get("node")
            if not node:
                raise RuntimeError("DeepSource check missing during pagination")
            page = node["issues"]
            issues["edges"].extend(page["edges"])
            issues["pageInfo"] = page["pageInfo"]
        else:
            raise RuntimeError("DeepSource issue pagination exceeded 100 pages")
    run["checks"]["edges"] = all_checks
    report, count = format_report(repo, sha, run)

    for pr in prs:
        number = pr["number"]
        previous = None
        for page in range(1, 11):
            batch = get_json(f"{gh}/issues/{number}/comments?per_page=100&page={page}",
                             github_token)
            for comment in batch:
                if (comment["user"]["login"] == "github-actions[bot]"
                        and MARKER in comment["body"]):
                    previous = comment
            if len(batch) < 100:
                break
        # Old runs must not overwrite a newer head's report.
        current = get_json(f"{gh}/pulls/{number}", github_token)
        if current["state"] != "open" or current["head"]["sha"] != sha:
            print(f"PR #{number}: head moved; skip stale report")
            continue
        if count == 0 and previous is None:
            print(f"PR #{number}: no findings")
            continue
        if count == 0:
            report = MARKER + "\n### DeepSource clear on " + sha[:7] + " ✅"
        if previous:
            if previous["body"] != report:
                get_json(f"{gh}/issues/comments/{previous['id']}", github_token,
                         "PATCH", {"body": report})
                print(f"PR #{number}: report updated")
        else:
            get_json(f"{gh}/issues/{number}/comments", github_token,
                     "POST", {"body": report})
            print(f"PR #{number}: report created")


if __name__ == "__main__":
    try:
        main()
    except (OSError, RuntimeError, ValueError, KeyError, TypeError) as exc:
        print(f"::error::DeepSource reporter: {exc}", file=sys.stderr)
        sys.exit(1)
