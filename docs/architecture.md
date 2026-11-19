# Architecture

The factory turns one manifest into a set of [gh-aw](https://github.github.com/gh-aw/) workflows and keeps them in step with it. The workflows then keep a fleet of repositories current: scheduled upkeep of each repository, and changes that flow from an upstream repository to the repositories that depend on it.

```text
sdlc.yaml ──▶ reconciler ──▶ .github/workflows/*.md ──▶ gh aw compile --strict ──▶ *.lock.yml
(manifest)    sdlc-reconcile  cascade-router.yml, aw.json
              sdlc-bootstrap
              sdlc-onboard

                 runs on GitHub Actions
   ┌───────────────┬────────────────────────┬──────────────────────────┐
   │ router        │ drift-<key>            │ cascade-mechanical-<id>  │
   │ polls each    │ ──▶ implement-<key>    │ cascade-ai-<id>          │
   │ upstream      │ scheduled upkeep       │ one edge: upstream ──▶   │
   └───────┬───────┴────────────────────────┤ downstream pull request  │
           └─ dispatches ───────────────────▶└──────────────────────────┘
                 state: SDLC_SYNC_STATE_<SLUG> variables, one per upstream
```

## The manifest

`sdlc.yaml` is the one source of truth: the projects of your fleet, the edges between them, and the commands, schedules and guard rails of each. It is validated against a JSON schema and a set of further checks. See the [manifest reference](manifest.md).

## The reconciler

The reconciler is a pure renderer with a transaction around it. Given the manifest and a nine-key request (the same for every run), it:

1. validates the request and the manifest, and refuses anything that breaks the security baseline;
2. renders every workflow file, deterministically: the same inputs give the same bytes;
3. checks the rendered files against the baseline again (strict mode on, threat detection on, no auto-merge, protected files blocked, App permissions within what the App was granted);
4. writes them and compiles them with `gh aw compile --strict --purge`;
5. rolls every file back to its previous bytes if anything fails.

Three commands run it: `sdlc-reconcile` runs it alone, `sdlc-bootstrap` runs it after setting up the GitHub App, variables and secrets, and `sdlc-onboard` runs it after adding a repository to the manifest. gh-aw 1.0.1 or newer is required, because earlier releases are affected by an advisory (see the [README](../README.md#prerequisites)).

## The generated workflows

| File under `.github/workflows/` | One for each | What it is |
| --- | --- | --- |
| `drift-<projectKey>.md` | project with `driftAudit.enabled` | The scheduled upkeep of one repository. An agent reads the watched sources, may open a pull request, and files a drift report as an issue. |
| `implement-<projectKey>.md` | project with `driftAudit.enabled` | Turns a drift report into one pull request. Started by the drift workflow with the report's number. |
| `cascade-mechanical-<edgeId>.md` | `mechanical` edge | Runs the edge's import commands in the downstream and opens a pull request. |
| `cascade-ai-<edgeId>.md` | `ai-adaptation` edge | An agent adapts the downstream to the upstream change, then the immutable gates verify its work. |
| `cascade-router.yml` | manifest | The router: a plain Actions workflow, not an agent. |
| `sdlc-onboard.md` | manifest | Asks an agent to run `sdlc-onboard` for one more repository (see [known limitations](#known-limitations)). |
| `aw.json` | manifest | gh-aw's repository configuration: strict mode, and the protected-files exclusions. |

Each `.md` is compiled by gh-aw into a `.lock.yml`, which is the file that GitHub runs. Commit both, and never edit them: change the manifest and run `sdlc-reconcile`. The text of the files can change from release to release; the [API page](api.md) says what is stable.

## The router

`cascade-router.yml` runs one job for each upstream, one at a time, each under its own concurrency group. It starts on the union of the edges' schedules, on a manual run, and on a `repository_dispatch` event of type `upstream_pr_merged`. That event only wakes the router: the router never takes its target from the payload, and always polls the upstream itself. The payload has six properties (`correlation_id`, `upstream_repo`, `merged_sha`, `pr_number`, `merged_at` and `default_branch`); see `UpstreamMergeClientPayload` in `sdlc-routing.schema.json`.

For one upstream, the router:

1. reads the sync state variable (a missing variable is an error; the router never creates one);
2. polls the upstream with a conditional request: the head of its default branch and its closed pull requests;
3. reads the downstream: the head of its default branch, and the commit that its provenance file records;
4. reconciles an open cascade pull request that the state records (merged: the merge cursor advances; closed unmerged: the target is dismissed), and resets the failure counters when the target, the downstream head or the manual input changed;
5. compares the target with, in this order, the merge cursor, the last no-op, the dismissed target, the blocked target, the run in flight and the open pull request;
6. otherwise runs the edge's preflight commands to decide whether anything material changed (after checking that the node scripts that they start exist: a missing one fails the job, because node's exit code 1 for it would read as drift), and either records a no-op or dispatches the cascade workflow of the edge without waiting for it.

It writes the state at most once, last, and only when a field other than `updatedAt` changed. A job that fails writes nothing and opens or updates one deduplicated `[sdlc-failure]` issue.

## Drift and implement

A drift workflow runs on its schedule (or manually, with an optional dry-run). Before the agent starts, host steps prepare its inputs: the run context, a list of open pull requests that it must not duplicate, the watch index of the previous run, and snapshots of the watched URLs and package manifests. The agent works inside a sandbox with a bash allowlist and only the network hosts that the manifest names. It can publish only through two safe outputs: one `create_pull_request` (to the target repository, never merged by the workflow) and one `create_issue` for the drift report. After the agent, your `verifyCommands` run as post-steps; a failure fails the run and `escalate_failure` opens a gate-failure issue.

When a report is filed, the drift workflow dispatches `implement-<projectKey>` with the report's number. The implementation workflow reads the report, researches each recommended item again, and opens one pull request that closes it.

## Cascades and the immutable gates

A **mechanical** edge needs no judgement for the change itself: its agent job runs the import commands from the manifest, commits what changed under `allowedFiles`, and calls `create_pull_request` on the edge's branch. Afterwards, plain steps check that the worktree is clean and that only allowed files changed, and run your build and verify commands.

An **AI-adaptation** edge captures evidence first: the upstream diff, the output of each preflight command and the open pull request of the edge. The agent decides whether anything must change, edits only the files in `allowedFiles`, runs the edge's deterministic commands, commits, and opens the pull request. When it has finished, `verify-immutable-gates` runs on the host and fails the run if the agent touched the guard rails of the downstream: paths in `zeroDiffPaths`, the locked parts of the companion test files, or constructs that the gate bans (a skipped test, a mocked module, a changed locked constant). It runs the downstream's own checks in a separate process under frozen intrinsics.

After the agent job, two plain jobs finish the run: `finalize_poll_state` verifies that the pull request on the edge's branch records the target commit and updates the state, and `escalate_failure` records a failure and opens the deduplicated failure issue.

## The GitHub App

The fleet acts through a GitHub App, never through a person's token. `sdlc-bootstrap` registers it (or uses one that you already have, through `APP_CLIENT_ID` and `APP_PRIVATE_KEY`), checks that it holds nothing beyond the ceiling below, and checks that it is installed with those permissions on the orchestrator repository, on every project with an enabled upkeep, on every downstream of an edge and, for a private factory, on the factory repository. An upstream-only repository on an account without an installation is a warning.

| Permission | Level |
| --- | --- |
| Contents | write |
| Pull requests | write |
| Issues | write |
| Actions | write |
| Variables | write |
| Metadata | read |

The client id is stored as the Actions variable `APP_CLIENT_ID`, and the private key as the secret `APP_PRIVATE_KEY`, in the orchestrator repository. The workflows mint short-lived installation tokens from them, each limited to the repositories that the job needs. One installation token belongs to one owner, so every downstream of an edge has to belong to the same owner as the orchestrator repository.

The App never merges, and no rendered workflow sets `auto-merge`. A token that is not an App installation token is refused by the scripts that call the API.

## Sync state

Each upstream has one Actions variable, `SDLC_SYNC_STATE_<SLUG>`, where the slug is the edge's `upstreamSlug`. `sdlc-bootstrap` creates it from the edge's `initialBaselineSha` when it does not exist and never updates it afterwards. The router and the poll-state script are the only writers; they write through GET and PATCH, refuse a value over 48 KB, and write only when a field changed. The value is one JSON object with 14 fields, always in this order:

| Field | Holds |
| --- | --- |
| `etag` | The ETag of the last conditional poll of the upstream. |
| `lastObservedHeadSha` | The head of the upstream's default branch when it was last polled. |
| `lastMergedUpstreamSha` | The upstream commit that the downstream has merged up to: the merge cursor. |
| `downstreamMainSha` | The head of the downstream's default branch when it was last read. The failure counters reset when it moves. |
| `lastNoopHeadSha` | An upstream head that was examined and needed nothing. |
| `dismissedTargetSha` | A target whose pull request was closed without merging. |
| `failedTargetSha`, `failedAttempts` | The target that failed, and how many times in a row. |
| `blockedTargetSha` | A target that failed twice. It is skipped until the state is reset. |
| `inFlightRunId`, `inFlightTargetSha` | The dispatched cascade run that has not finished, and its target. Written together. |
| `openPrNumber`, `openPrTargetSha` | The open cascade pull request and its target. Written together. |
| `updatedAt` | When the state was last written. |

**Resetting a blocked state.** Never edit the variable by hand. Run `cascade-router.yml` with `workflow_dispatch` and `reset_blocked` set to `true`: it clears the failure and blocked state of every upstream before routing, inside the same concurrency lock as a normal run.

### The state dialect

The fourth field of the state has two spellings: `downstreamMainSha`, which the factory uses, and the legacy `portfolioMainSha`. Code that expects the legacy spelling rejects a variable that has the new one, so renaming has to be a decision of yours, not something that happens on upgrade:

- The factory reads either name.
- It writes the name that it read, unless `state.dialect` in the manifest says otherwise. The default is `preserve`.
- New variables are seeded with the legacy name unless you set `state: { dialect: downstream }`. A fleet that starts with this factory has nothing to roll back to and can set it from the start.

To move an existing fleet, set `state.dialect: downstream` once nothing that reads the variable expects the legacy name. Waiting at least 14 days and for at least one real cascade on each AI-adaptation edge first is a sensible rollback window. Each variable then converts on its next write, once. Check that it did:

```bash
gh api repos/<owner>/<orchestrator>/actions/variables/SDLC_SYNC_STATE_<SLUG> --jq '.value | fromjson | keys[] | select(test("MainSha$"))'
```

To roll back after the flip, set `state.dialect: legacy`, wait until every variable shows `portfolioMainSha`, and only then bring back the code that expects the legacy name. The legacy name is read until 1.0.0.

## The factory repository's own safeguards

The factory repository ships a leak guard, `tools/leak-guard`, because its history is meant to be published. It runs in `npm test` and in CI: the tree on every run, and the history, with its tags, on every run that is not a pull request.

- `node tools/leak-guard/scan.mjs --tree` scans every tracked file and every path with generic rules (home-directory paths, e-mail addresses, internal hosts, tokens and key headers, GUIDs, run ids in comments, lockfile registries) and with a denylist of SHA-256 digests. The denylist holds digests, not terms, so the repository never contains what it forbids. A finding prints a position and a rule, never the matched text.
- A term is found in the spellings that code has: in any case, with any separator or none, in camelCase and with digits attached, and glued to other letters, either inside a longer word or, for a term of several words, by up to three characters at an end. A hexadecimal token of 24 characters or more, such as a commit hash, is not searched inside.
- A term, and a match of a generic rule, that a line break cuts in two is found when it spans two adjacent lines, in a file, in a commit or tag message and in a diff. It is reported on the line where it ends. A term cut over three lines, or by a blank line, is not found.
- A line is also searched as it decodes: percent-encoding, backslash escapes (`\u0041`, `\x41`) and HTML entities (`&#65;`, `&amp;`), up to two layers deep. A hit that only the decoded line has is reported over the whole line.
- A binary file is read for its printable strings (UTF-8 or ASCII, and UTF-16LE of the ASCII range, of four characters or more), and each string is searched like a line; its finding names the string's place among the strings in place of a line number. In the history, the strings of a binary blob before and after a change are compared, and the ones that only one of them has are the added and the removed lines.
- `--history` applies the same rules to every added and removed line of every commit, to commit messages, authors and committers, and to the name, tagger and message of every tag.
- `--report` prints counts only.
- `tools/leak-guard/allow.json` holds reviewed exceptions, each with a reason; an exception that no longer matches anything fails the run. An exception for a token-shaped constant in a file (`secret-shape`) names the lines it waives (`lines`), so a second constant added to the same file still fails, and a line it names that waives nothing fails the run too. The history cannot know where a line was in an earlier commit, so there an exception covers its rule in its paths, whatever the line.

The digests make an accident visible. They do not hide anything from someone who already has a candidate term, because a short term has little entropy.

## Where the code is

| Directory | Holds |
| --- | --- |
| `src/reconcile.mjs` | The renderer and the reconciler. |
| `src/route-upstream.mjs`, `src/routing/` | The router and the pieces it shares with the poll-state script. |
| `src/update-poll-state.mjs`, `src/ai-pull-request-result.mjs` | The only writer of the state variable, and the result of an AI-adaptation run. |
| `src/verify-immutable-gates.mjs`, `src/adaptation/` | The immutable gates. |
| `src/drift/` | The host-side steps of drift and implementation workflows. |
| `bin/` | The three commands and the code behind the bootstrap and onboarding. |
| `schemas/` | The JSON schemas. |
| `prompts/` | The built-in prompt fragments for the upkeep strategies. A `prompts/drift/strategy-<name>.md` in your repository overrides the built-in one. |

## Known limitations

- **The onboarding workflow cannot complete on its own.** The generated `sdlc-onboard` workflow tells its agent to run `sdlc-onboard`, but the workflow installs neither the factory nor the gh-aw CLI, does not pass the App's credentials to a step that runs the command, and gives the agent no network access. Run `sdlc-onboard` from your own machine.
- **No failure issue when the factory cannot be installed** in `escalate_failure` or `finalize_poll_state`. The failing job in the Actions run is the signal.
- **Dependabot and Renovate** have not been checked with npm git dependencies. Update the factory by hand, as the [README](../README.md#updating) describes.
