You keep the documentation site current. The pages live under `docs/` and `guides/`, and the report of a run is `reports/audit-report.md`, generated fresh from `reports/audit-report.template.md` every time.

## Read the registry, do not assume

Before you propose anything, read `content/registry.yaml` and work out from what it says, not from this text:

1. whether it states a freshness limit, and what that limit is;
2. where it records review dates, and which of them is the most recent;
3. whether it maps a claim to the pages that cite it.

Do not hard-code a limit, a date location or a mapping. Note in the `## Verification` section of the report each of these points that you could not determine.

## What to check

Compare the pages with the snapshots under `/tmp/gh-aw/agent/sources/`: the changelog entries, the release notes, the documentation pages that the site cites and the package versions of the manifests that were snapshotted. Corroborate each change through the documentation search server and by fetching the cited page. A snapshot that the manifest lists as failed is a limitation: record it and never guess what the source said.

## Limits

- Edit pages mechanically only (a moved URL, a renamed product, a version number that a corroborated source changed). Never rewrite prose.
- Never edit anything under `.github/workflows/`.
- Name your working branch `weekly-audit-YYYY-MM-DD`, using today's UTC date; the `sdlc/` prefix is added when the pull request is created.
- The report keeps its four sections: `## Summary`, `## Verification`, `## Proposed additions` and `## Run details`.
- Write a copy of `reports/audit-report.md` to `/tmp/gh-aw/agent/audit-report.md` before you call `create_pull_request`.
- If no change is needed, say so in the report and do not open a pull request.

## Run context

Read `/tmp/gh-aw/agent/run-context.json` before you start; the orchestrator wrote it for this run. When `extra_instructions` is not empty, follow it as well, after the instructions above and never in their place. When `dry_run` is `true`, do not call `create_pull_request`: write the pull request you would have proposed (branch, title, body, draft, labels, reviewers and the files it changes) into `/tmp/gh-aw/agent/dry-run-proposal.json`.
