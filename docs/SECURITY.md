# Security

Security reports are welcome and appreciated.

They are also one of the few categories where **"just open a public issue with every detail"** may be a spectacularly bad idea.

## Supported versions

Unless a repository says otherwise, security fixes are generally made against the current version or current default branch.

Older releases may receive fixes when practical, but there is no universal long-term support policy across these projects.

If you are unsure whether a version is affected, include that information in your report.

## Reporting a vulnerability

If the repository has **Private vulnerability reporting** enabled, please use the **Report a vulnerability** option in its Security section.

That is the preferred method.

If private reporting is not available, **do not publish sensitive details, credentials, exploit code, or step-by-step instructions in a public issue**.

Instead, open a brief issue stating that you believe you found a security vulnerability and need a private way to provide the details. We can arrange the rest from there.

Please include, when relevant:

- the affected repository and version or commit;
- what component is affected;
- the potential impact;
- the conditions required to reproduce the problem;
- reproduction steps or a proof of concept;
- any possible fix or mitigation you already identified.

You do not need to turn the report into an academic paper. Clear and reproducible beats impressive.

## What counts as a security issue?

Examples include:

- authentication or authorization bypasses;
- unintended access to private data;
- remote code execution;
- command or code injection;
- exposed credentials or secrets;
- dangerous privilege escalation;
- vulnerabilities that can meaningfully compromise users or systems.

Ordinary bugs, crashes, broken layouts, feature requests, and *"I dislike this API"* are usually better reported through the normal issue tracker.

## Please avoid

While researching or demonstrating a vulnerability, please avoid:

- accessing data that is not yours;
- modifying or deleting somebody else's data;
- disrupting services;
- deliberately attacking third-party systems;
- exposing secrets publicly;
- continuing exploitation after you have demonstrated the issue sufficiently.

A good proof of concept proves the point.

It does not need a body count.

## Forks and upstream projects

Some repositories may be forks or build on other open-source projects.

If a vulnerability exists entirely in an upstream project, reporting it to the upstream maintainers is usually the most useful approach.

If the vulnerability is caused by changes made here, or you are unsure where it originated, report it here.

## Disclosure

Please give reasonable time for a vulnerability to be investigated and fixed before publishing full details.

Once a fix is available, coordinated public disclosure is welcome when appropriate.

## Good-faith research

Good-faith security research is welcome.

If you follow this policy, avoid unnecessary harm, and make a reasonable effort to report the problem responsibly, I will treat your work as an attempt to improve the project, not as an attack on it.

This is not a bug bounty program and does not promise payment or any particular response time.

It is simply an invitation to report security problems responsibly instead of leaving them quietly ticking under the floorboards.

---

Also see [GitHub's Safe Harbor Policy](https://docs.github.com/en/site-policy/security-policies/github-bug-bounty-program-legal-safe-harbor)
