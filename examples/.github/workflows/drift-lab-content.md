---
on:
  schedule:
    - cron: 30 6 * * 4
  workflow_dispatch:
    inputs:
      target_repo:
        description: "Optional guard: must be empty or equal the configured target repository"
        type: string
      correlation_id:
        description: Correlation id recorded in run context and failure issues
        type: string
      extra_instructions:
        description: Extra instructions appended after the registration instructions
        type: string
      dry_run:
        description: When true, create no branch, pull request or issue
        type: boolean
        default: false
  bots:
    - example-orchestrator[bot]
concurrency:
  group: sdlc-drift-lab-content
  cancel-in-progress: false
permissions:
  actions: read
  contents: read
  issues: read
  pull-requests: read
network:
  allowed:
    - changelog.example.org
    - docs.example.net
    - releases.example.org
checkout:
  - repository: example-org/lab-content
    path: lab-content
    current: true
    github-app:
      client-id: ${{ vars.APP_CLIENT_ID }}
      private-key: ${{ secrets.APP_PRIVATE_KEY }}
      repositories:
        - lab-content
mcp-servers:
  context-lookup:
    args:
      - -y
      - "@example-org/context-mcp@latest"
    command: npx
  docs-search:
    type: http
    url: https://mcp.example.org/docs
pre-agent-steps:
  - name: Mint the factory read token
    id: factory_token
    uses: actions/create-github-app-token@v2
    with:
      app-id: ${{ vars.APP_CLIENT_ID }}
      private-key: ${{ secrets.APP_PRIVATE_KEY }}
      owner: example-org
      repositories: ai-sdlc-factory
      permission-contents: read
  - name: Install the factory
    env:
      GIT_TERMINAL_PROMPT: "0"
      GIT_CONFIG_COUNT: "3"
      GIT_CONFIG_KEY_0: url.https://x-access-token:${{ steps.factory_token.outputs.token }}@github.com/example-org/ai-sdlc-factory.insteadOf
      GIT_CONFIG_VALUE_0: ssh://git@github.com/example-org/ai-sdlc-factory
      GIT_CONFIG_KEY_1: url.https://x-access-token:${{ steps.factory_token.outputs.token }}@github.com/example-org/ai-sdlc-factory.insteadOf
      GIT_CONFIG_VALUE_1: git@github.com:example-org/ai-sdlc-factory
      GIT_CONFIG_KEY_2: url.https://x-access-token:${{ steps.factory_token.outputs.token }}@github.com/example-org/ai-sdlc-factory.insteadOf
      GIT_CONFIG_VALUE_2: https://github.com/example-org/ai-sdlc-factory
    run: npm ci --ignore-scripts
  - name: Prepare run context
    env:
      CONFIGURED_TARGET_REPO: example-org/lab-content
      TARGET_REPO_INPUT: ${{ inputs.target_repo }}
      CORRELATION_ID: ${{ inputs.correlation_id }}
      EXTRA_INSTRUCTIONS: ${{ inputs.extra_instructions }}
      DRY_RUN: ${{ inputs.dry_run }}
    run: node "$GITHUB_WORKSPACE/node_modules/ai-sdlc-factory/src/drift/prepare-run.mjs" --out /tmp/gh-aw/agent --target-repo "$TARGET_REPO_INPUT" --correlation-id "$CORRELATION_ID" --extra-instructions "$EXTRA_INSTRUCTIONS" --dry-run "$DRY_RUN" --factory-dir node_modules/ai-sdlc-factory --stage-scripts scripts/validate-example.mjs
  - name: Deduplicate open pull requests
    env:
      CONFIGURED_TARGET_REPO: example-org/lab-content
      APP_CLIENT_ID: ${{ vars.APP_CLIENT_ID }}
      APP_PRIVATE_KEY: ${{ secrets.APP_PRIVATE_KEY }}
    run: node "$GITHUB_WORKSPACE/node_modules/ai-sdlc-factory/src/drift/dedupe-open-prs.mjs" --out /tmp/gh-aw/agent --target-repo "$CONFIGURED_TARGET_REPO" --close-older-key sdlc-drift-lab-content --upkeep-strategy content-and-docs-sync --project lab-content
  - name: Find the watch index of the previous run
    env:
      GH_TOKEN: ${{ github.token }}
    run: node "$GITHUB_WORKSPACE/node_modules/ai-sdlc-factory/src/drift/previous-watch-index.mjs" --out /tmp/gh-aw/agent --workflow drift-lab-content.lock.yml --artifact sdlc-watch-index-lab-content
  - name: Snapshot watched sources and package manifests
    env:
      CONFIGURED_TARGET_REPO: example-org/lab-content
    run: node "$GITHUB_WORKSPACE/node_modules/ai-sdlc-factory/src/snapshot-watch-sources.mjs" --out /tmp/gh-aw/agent --project lab-content --checkout lab-content --previous /tmp/gh-aw/agent/previous
  - name: Upload the watch index
    if: inputs.dry_run != true
    uses: actions/upload-artifact@v4
    with:
      name: sdlc-watch-index-lab-content
      path: /tmp/gh-aw/agent/sources/watch-index.json
      if-no-files-found: error
post-steps:
  - name: ( set -euo pipefail; copy="${RUNNER_TEMP:?RUNNER_TEMP is not set}/gh-aw/sdlc-validator"; cmp -s "$copy/scripts/validate-example.mjs" "$GITHUB_WORKSPACE/scripts/validate-example.mjs" || { echo "scripts/validate-example.mjs is not the copy that prepare-run made before the agent started" >&2; exit 1; }; cmp -s "$copy/node_modules/ai-sdlc-factory/package.json" "$GITHUB_WORKSPACE/node_modules/ai-sdlc-factory"/package.json || { echo "node_modules/ai-sdlc-factory/package.json is not the copy that prepare-run made before the agent started" >&2; exit 1; }; diff -rq "$copy/node_modules/ai-sdlc-factory/src/drift/lib" "$GITHUB_WORKSPACE/node_modules/ai-sdlc-factory"/src/drift/lib >&2 || { echo "node_modules/ai-sdlc-factory/src/drift/lib is not the copy that prepare-run made before the agent started" >&2; exit 1; }; ! test -e "$GITHUB_WORKSPACE/scripts/node_modules" || { echo "scripts/node_modules is not the copy that prepare-run made before the agent started" >&2; exit 1; }; node "$copy/scripts/validate-example.mjs" )
    run: ( set -euo pipefail; copy="${RUNNER_TEMP:?RUNNER_TEMP is not set}/gh-aw/sdlc-validator"; cmp -s "$copy/scripts/validate-example.mjs" "$GITHUB_WORKSPACE/scripts/validate-example.mjs" || { echo "scripts/validate-example.mjs is not the copy that prepare-run made before the agent started" >&2; exit 1; }; cmp -s "$copy/node_modules/ai-sdlc-factory/package.json" "$GITHUB_WORKSPACE/node_modules/ai-sdlc-factory"/package.json || { echo "node_modules/ai-sdlc-factory/package.json is not the copy that prepare-run made before the agent started" >&2; exit 1; }; diff -rq "$copy/node_modules/ai-sdlc-factory/src/drift/lib" "$GITHUB_WORKSPACE/node_modules/ai-sdlc-factory"/src/drift/lib >&2 || { echo "node_modules/ai-sdlc-factory/src/drift/lib is not the copy that prepare-run made before the agent started" >&2; exit 1; }; ! test -e "$GITHUB_WORKSPACE/scripts/node_modules" || { echo "scripts/node_modules is not the copy that prepare-run made before the agent started" >&2; exit 1; }; node "$copy/scripts/validate-example.mjs" )
    working-directory: lab-content
  - name: ( set -euo pipefail; for f in tests/catalog-links.test.js tests/page-layout.test.js; do test -f "$f" || { echo "missing required test file $f" >&2; exit 1; }; done; npm ci; npm test )
    run: ( set -euo pipefail; for f in tests/catalog-links.test.js tests/page-layout.test.js; do test -f "$f" || { echo "missing required test file $f" >&2; exit 1; }; done; npm ci; npm test )
    working-directory: lab-content
safe-outputs:
  github-app:
    client-id: ${{ vars.APP_CLIENT_ID }}
    private-key: ${{ secrets.APP_PRIVATE_KEY }}
    repositories:
      - lab-content
  report-failure-as-issue: false
  threat-detection:
    continue-on-error: false
  create-pull-request:
    target-repo: example-org/lab-content
    title-prefix: "chore(sdlc-drift): "
    labels:
      - automated
      - sdlc-drift
      - needs-review
    reviewers: []
    draft: false
    branch-prefix: sdlc/
    preserve-branch-name: true
    recreate-ref: false
    close-older-pull-requests: false
    close-older-key: sdlc-drift-lab-content
    if-no-changes: error
    exclude-lock-yml: true
    protected-files:
      policy: blocked
      exclude:
        - /README.md
    auto-merge: false
    fallback-as-issue: true
    max: 1
    max-patch-size: 10240
  create-issue:
    target-repo: example-org/lab-content
    title-prefix: "[sdlc-drift] "
    labels:
      - automated
      - sdlc-drift
      - drift-report
    close-older-issues: false
    max: 1
engine:
  id: copilot
  copilot-sdk: true
  env:
    COPILOT_GITHUB_TOKEN: ${{ secrets.COPILOT_GITHUB_TOKEN }}
  args:
    - --allow-url
    - changelog.example.org
    - --allow-url
    - docs.example.net
    - --allow-url
    - releases.example.org
tools:
  web-fetch: {}
  bash:
    - cat
    - cd
    - curl
    - cut
    - date
    - find
    - git
    - grep
    - head
    - ls
    - node
    - sed
    - tail
    - wc
  edit: {}
jobs:
  detection:
    if: needs.agent.result == 'success'
  safe_outputs:
    if: needs.agent.result == 'success' && inputs.dry_run != true
  conclusion:
    if: inputs.dry_run != true
  escalate_failure:
    needs:
      - agent
      - detection
      - safe_outputs
    if: failure() && inputs.dry_run != true
    detection-gate: status-only
    permissions:
      actions: read
      contents: read
      issues: write
    steps:
      - uses: actions/checkout@v4
        with:
          sparse-checkout: |-
            /package.json
            /package-lock.json
            /sdlc.yaml
          sparse-checkout-cone-mode: false
          persist-credentials: false
      - name: Mint the factory read token
        id: factory_token
        uses: actions/create-github-app-token@v2
        with:
          app-id: ${{ vars.APP_CLIENT_ID }}
          private-key: ${{ secrets.APP_PRIVATE_KEY }}
          owner: example-org
          repositories: ai-sdlc-factory
          permission-contents: read
      - name: Install the factory
        env:
          GIT_TERMINAL_PROMPT: "0"
          GIT_CONFIG_COUNT: "3"
          GIT_CONFIG_KEY_0: url.https://x-access-token:${{ steps.factory_token.outputs.token }}@github.com/example-org/ai-sdlc-factory.insteadOf
          GIT_CONFIG_VALUE_0: ssh://git@github.com/example-org/ai-sdlc-factory
          GIT_CONFIG_KEY_1: url.https://x-access-token:${{ steps.factory_token.outputs.token }}@github.com/example-org/ai-sdlc-factory.insteadOf
          GIT_CONFIG_VALUE_1: git@github.com:example-org/ai-sdlc-factory
          GIT_CONFIG_KEY_2: url.https://x-access-token:${{ steps.factory_token.outputs.token }}@github.com/example-org/ai-sdlc-factory.insteadOf
          GIT_CONFIG_VALUE_2: https://github.com/example-org/ai-sdlc-factory
        run: npm ci --ignore-scripts
      - name: Escalate gate failure
        env:
          GH_TOKEN: ${{ secrets.GITHUB_TOKEN }}
          WORKFLOW_ID: drift-lab-content
          TARGET_REPO: example-org/lab-content
          CORRELATION_ID: ${{ inputs.correlation_id }}
          RUN_URL: ${{ github.server_url }}/${{ github.repository }}/actions/runs/${{ github.run_id }}
        run: node "$GITHUB_WORKSPACE/node_modules/ai-sdlc-factory/src/drift/escalate-gate-failure.mjs" --workflow-id "$WORKFLOW_ID" --target-repo "$TARGET_REPO" --correlation-id "$CORRELATION_ID" --run-url "$RUN_URL"
  implement_report:
    needs:
      - safe_outputs
    if: needs.safe_outputs.result == 'success' && needs.safe_outputs.outputs.created_issue_number != '' && inputs.dry_run != true
    permissions:
      actions: write
    steps:
      - name: Start the implementation of the drift report
        env:
          GH_TOKEN: ${{ github.token }}
          WORKFLOW_FILE: implement-lab-content.lock.yml
          REPORT_ISSUE: ${{ needs.safe_outputs.outputs.created_issue_number }}
          CORRELATION_ID: ${{ inputs.correlation_id || format('run-{0}-{1}', github.run_id, github.run_attempt) }}
        run: gh workflow run "$WORKFLOW_FILE" --repo "$GITHUB_REPOSITORY" --ref "$GITHUB_REF_NAME" -f report_issue="$REPORT_ISSUE" -f correlation_id="$CORRELATION_ID"
---

# Upkeep: lab-content

You maintain the repository `example-org/lab-content`, checked out at `lab-content/` in the workspace. Work only inside that checkout and follow the registration instructions below.

## Registration instructions

Audit the content registry and the lab pages against the watched sources and propose only safe, mechanical updates.

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

## Upkeep strategy: content-and-docs-sync

Compare the watched-source snapshots with the target's documentation, labs and presentation content, and update only what a corroborated source contradicts.

## Watched sources

Snapshots of these pages are in `/tmp/gh-aw/agent/sources/` (see `manifest.json` there for fetch results):

- Platform changelog (changelog): https://changelog.example.org/
- Platform changelog feed (feed): https://changelog.example.org/feed/
- Runtime releases (release-notes): https://releases.example.org/runtime/releases
- Command-line tool releases (release-notes): https://releases.example.org/cli/releases

The snapshot step also saved the text of the pages that this repository cites most: up to 60 pages on `docs.example.net` that files matching `README.md`, `modules/**/*.md` and `docs/**/*.md` link to, under `/tmp/gh-aw/agent/sources/cited/`. `manifest.json` lists each of them with the files that cite it.

## What changed since the last run

Start with `/tmp/gh-aw/agent/sources/changes.md`. It compares this run's snapshots with the watch index of the last successful run (its first line names that run, or says that there is none and why) and lists the changelog, feed and release entries that are new since then, each once with the sources that list it, the pages and cited pages whose text changed, with the files of this repository that cite them, and the sources that could not be fetched.

When a source's first page lists none of the entries that the baseline knew, the snapshot step has read its older pages until one does, up to a limit; a source that still does not reach the baseline is listed under `## Possible gaps` with the period that neither run saw. Open the older pages of that source for that period yourself, decide those entries as well, and name the gap under `## Limitations` when you cannot.

That list is your work list, and every item of it gets a decision. Triage each item first from its title and excerpt: search this repository for the feature, setting or product that it names. Open, read and corroborate the items that touch something this repository covers or should cover, and read an entry or a page with `curl --fail --silent --show-error --location <url>` whenever its excerpt is not enough to decide, piped into `grep` or `head` when the page is long: `curl` reaches the hosts of the watched URLs and of the cited pages and no other, there is no `web_fetch` tool, and the shell has no `wget` or `gh` and refuses a redirection or a heredoc. An item that does not concern this repository is not relevant: count it, but do not list it in the report. A long list is no reason to skip items: decide each one.

## Drift report

File a drift report when at least one item of the work list is recommended or could not be confirmed, or when this run has a limitation that a human has to know about: a source that could not be fetched, or a possible gap that you could not close. File it with exactly one `create_issue` call; a human reads it, and filing it starts its implementation: a run of the workflow `implement-lab-content` researches every item under `## Recommended` and `## Could not confirm` again and opens one pull request that closes the report, starting from the report alone. Title it `Drift report: lab-content YYYY-MM-DD` with the current UTC date (the `[sdlc-drift] ` prefix is added for you). When there is nothing of that kind (every item is not relevant or applied by your pull request, every source was fetched and every gap closed), file no report: call `noop` with one line that says how many items you triaged and which baseline you compared with. Your pull request lists the items that it applies; the report does not list them again.

When the registration instructions above define a report of their own (such as `reports/audit-report.md` or `reports/improvement-report.md`), write that report as they say on every run, a dry run and a run that changes nothing included, because the checks that run after you look for it; the body of the issue is that report followed by the sections below other than `## Summary`. Otherwise the body has these sections, in this order, and leaves out `## Recommended` and `## Could not confirm` when they would be empty:

- `## Summary`: the baseline run, what changed upstream since then and what this run did, including the pull request that it opened, if any, and one line that counts the items that you triaged as not relevant (never list them).
- `## Recommended`: a task list (`- [ ] `) of what this run did not change and should be changed: content that the sources announce and this repository does not cover yet (a new feature, setting, limit or retirement that deserves a lab step, a slide or a reference note), corrections and judgement calls. Each item says what to change, names the files that it concerns and links its source.
- `## Could not confirm`: a task list (`- [ ] `) of the claims that you could not corroborate, each with its source, what stopped you and the files that it would concern.
- `## Limitations`: the sources that could not be fetched, the possible gaps that you could not close and the checks that could not run.

Call `create_pull_request` before `create_issue` and name the pull request in the report. In a dry run call neither: `/tmp/gh-aw/agent/dry-run-proposal.json` exists already with `null` under `proposal` and `report`; replace the `null` of `report` with the report that you would have filed, `{ "title": ..., "body": ... }`, using the edit tool: the shell of this workflow refuses a redirection or a heredoc. Leave it `null` when you would have filed none.

## Package manifests

Dependency versions were snapshotted from files matching:

- `package.json`
- `tools/package.json`
- `**/*.csproj`

## Build commands

This project has no build commands.

## Operating rules

- Read `/tmp/gh-aw/agent/open-pr-dedup.json` before you call `create_pull_request`; skip the pull request when it lists a matching open pull request that you must not duplicate (`duplicate` is `true`: a match whose `decision` is `skip`), and list what you would have changed under `## Recommended` of the drift report instead. A match whose `decision` is `ignore` is an earlier pull request of this same workflow, which stays open and carries other items, the pull request of another upkeep or the implementation of an earlier report: none is a reason to skip. Never open a duplicate.
- Corroborate every proposed change through the Microsoft Learn and Context7 servers or by fetching the cited page.
- Commit rebuilt outputs and source edits to the working branch before you call `create_pull_request`.
- Never run `git push`, `gh pr` or a write-method `gh api` call and never merge: pull requests and issues are created only through the `create_pull_request` and `create_issue` safe outputs.
- The verification commands run after you finish; fix the cause of a failure rather than working around it.
- If you find no drift, record that outcome and do not open a pull request.
