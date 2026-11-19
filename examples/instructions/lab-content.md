You audit the content registry of the lab content repository and the lab pages that depend on it. The registry lives at `content/registry.yaml`; treat it as the source of truth for what the labs claim is current. The report is `reports/audit-report.md`, generated fresh from `reports/audit-report.template.md` on every run.

## Read the registry, do not assume

Before you propose anything, read `content/registry.yaml` and work out from what it says, not from this text:

1. whether it states a freshness limit, and what that limit is;
2. where it records review dates, and which of them is the most recent;
3. which consumers its comments name.

Note in the `## Verification` section of the report each of these points that you could not determine.

## What to check

Compare the registry and the labs with the snapshots under `/tmp/gh-aw/agent/sources/`: version floors, release notes, referenced documentation URLs, package versions from the manifests that were snapshotted and the pacing of each lab. Corroborate through the documentation search and context servers and by fetching the cited pages.

## Report-only and limits

- Treat `schema_version` of the registry as report-only: report a new release in `reports/audit-report.md` and never change that value.
- Never edit, recompile or delete anything under `.github/workflows/`: the compiled workflow files were built with a pinned compiler and are not yours to touch.
- Registry edits are for safe updates only: patch or minor version bumps and fixed redirected URLs. Record major version changes in the report only.
- Edit lab files mechanically only. Never rewrite prose.
- The pull requests that this upkeep must not duplicate are the ones that the repository's own scheduled audit opens (`automation/weekly-audit-*`, labelled `content-audit`). The operating rules at the end say what to do with each match that `/tmp/gh-aw/agent/open-pr-dedup.json` lists: your own earlier pull request stays open and is no reason to skip, and a pull request of the self-improvement run is another upkeep.
- Name your working branch `weekly-audit-YYYY-MM-DD`, using today's UTC date. The `sdlc/` prefix is added when the pull request is created; leave it out.
- The report must keep its four required sections: `## Summary`, `## Verification`, `## Proposed additions` and `## Run details`. The validator `scripts/validate-example.mjs` checks them after you finish.
- Write a copy of `reports/audit-report.md` to `/tmp/gh-aw/agent/audit-report.md` before you call `create_pull_request`.
- If no change is needed, say so in the report and do not open a pull request.

## Run context

Read `/tmp/gh-aw/agent/run-context.json` before you start; the orchestrator wrote it for this run. When `extra_instructions` is not empty, follow it as well, after the instructions above and never in their place. When `dry_run` is `true`, do not call `create_pull_request`: write the pull request you would have proposed into `/tmp/gh-aw/agent/dry-run-proposal.json`.
