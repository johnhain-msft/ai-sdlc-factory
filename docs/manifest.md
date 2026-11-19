# Manifest reference

The fleet manifest declares the repositories of your fleet and the edges between them. The reconciler reads it and renders the workflows ([architecture](architecture.md)); the scripts that those workflows run read it again at run time.

It is a YAML file named `sdlc.yaml` at the root of your orchestrator repository. Set `SDLC_MANIFEST` to a path relative to the repository root, ending in `.yaml` or `.yml`, to keep it elsewhere. The file is validated against `schemas/sdlc.schema.json` (importable as `ai-sdlc-factory/schemas/sdlc.schema.json`) and then against the [checks beyond the schema](#checks-beyond-the-schema). A key that the schema does not define is refused, except inside the free-form values `mcpServers`, `adaptation.helpers`, `adaptation.pullRequestResult`, `immutableGates.lockedTestBlocks` and `immutableGates.inProcessInvariants`.

## A complete example

This manifest has one scheduled upkeep, one mechanical edge and one AI-adaptation edge. The names are invented. Replace `<owner>` with the account that hosts the factory repository.

```yaml
factory:
  package: ai-sdlc-factory
  source: github:<owner>/ai-sdlc-factory
  private: true
state:
  dialect: downstream
prompts:
  reportExamples: [docs/audit-report.md]
  pullRequestBodyItems: the adapted pages
onboarding:
  provenanceNames: [source.json, provenance.json]
dedupe:
  upkeeps:
    - id: weekly-audit
      branchPrefixes: [automation/weekly-audit-]
      labels: [content-audit]
  strategyUpkeep:
    content-and-docs-sync: weekly-audit
protectedFilesExclude: [package.json]
projects:
  - projectKey: docs-site
    repo: example-org/docs-site
    defaultBranch: main
    driftAudit:
      enabled: true
      schedule: "15 4 * * 2"
      upkeepStrategy: content-and-docs-sync
      instructions: Keep the documentation in step with the product changelog.
      instructionsFile: null
      knowledgeSources:
        watchUrls:
          - url: https://example.org/changelog
            label: Example changelog
            kind: changelog
        packageManifests: [package.json]
        mcpServers: {}
      buildCommands: [npm run build]
      verifyCommands: [npm ci, npm test]
      draft: false
      reviewers: [example-reviewer]
  - projectKey: lab-content
    repo: example-org/lab-content
    defaultBranch: main
    driftAudit:
      enabled: false
      schedule: "0 0 * * 0"
      upkeepStrategy: custom
      instructions: ""
      instructionsFile: null
      knowledgeSources: { watchUrls: [], packageManifests: [], mcpServers: {} }
      buildCommands: []
      verifyCommands: []
      draft: false
      reviewers: []
  - projectKey: hub
    repo: example-org/hub
    defaultBranch: main
    driftAudit:
      enabled: false
      schedule: "0 0 * * 0"
      upkeepStrategy: custom
      instructions: ""
      instructionsFile: null
      knowledgeSources: { watchUrls: [], packageManifests: [], mcpServers: {} }
      buildCommands: []
      verifyCommands: []
      draft: false
      reviewers: []
dependencyEdges:
  - edgeId: docs-to-hub
    mode: mechanical
    upstreamRepo: example-org/docs-site
    upstreamKey: docs-site
    upstreamSlug: DOCS_SITE
    upstreamDefaultBranch: main
    initialBaselineSha: "0123456789abcdef0123456789abcdef01234567"
    downstreamRepo: example-org/hub
    schedule: "0 */6 * * *"
    onCommitOnlyAdvance: noop
    stateVariable: SDLC_SYNC_STATE_DOCS_SITE
    provenanceFile: provenance.json
    provenanceJsonPointer: /commit
    branchName: sdlc/cascade-docs-to-hub
    closeOlderKey: sdlc-cascade-docs-to-hub
    reviewers: [example-reviewer]
    importCommands: ["node scripts/import.mjs <checkout>"]
    preflightCommands: []
    acceptCommands: []
    buildCommands: [npm run build]
    verifyCommands: [npm test]
    adaptationInstructions: ""
    allowedFiles: ["docs/imported/**"]
    protectedFilesExclude: []
    autoMerge: false
    immutableGates: { zeroDiffPaths: [] }
  - edgeId: lab-to-hub
    mode: ai-adaptation
    upstreamRepo: example-org/lab-content
    upstreamKey: lab-content
    upstreamSlug: LAB_CONTENT
    upstreamDefaultBranch: main
    initialBaselineSha: "0123456789abcdef0123456789abcdef01234567"
    downstreamRepo: example-org/hub
    schedule: "30 */6 * * *"
    onCommitOnlyAdvance: bump-provenance
    stateVariable: SDLC_SYNC_STATE_LAB_CONTENT
    provenanceFile: provenance.json
    provenanceJsonPointer: /lab/commit
    branchName: sdlc/cascade-lab-to-hub
    closeOlderKey: sdlc-cascade-lab-to-hub
    reviewers: [example-reviewer]
    importCommands: []
    preflightCommands: ['git -C <checkout> diff --quiet "$LAST_MERGED_SHA" "$TARGET_SHA"']
    acceptCommands: []
    buildCommands: [npm run build]
    verifyCommands: [npm test]
    adaptationInstructions: Adapt the hub pages to the changed lab content.
    allowedFiles: ["site/**"]
    protectedFilesExclude: []
    autoMerge: false
    syncScopes: [both, content-only]
    immutableGates:
      zeroDiffPaths: [kernel]
      generatedPaths: ["dist/**"]
    adaptation:
      pullRequestResult:
        pages: "site/pages/**"
```

## Conventions

- **Placeholders** in commands: `<checkout>` is the upstream checkout (`"$UPSTREAM_DIR"`), `<factory>` is the factory directory as a quoted absolute path, and `<factory-dir>` is the same directory relative to the workspace.
- **Expressions.** No string may contain the expression opener `${{`: the reconciler refuses it.
- **Paths** are relative to the repository root and use `/`.
- **Commands** are bash text. The reconciler refuses a blank one.
- **Auto-merge** is never on. `autoMerge` can only be `false`, and the reconciler refuses an enabled auto-merge anywhere in what it renders.

## Reference

How to read the tables: *Required* means required when the parent key is present. *Default* is what the reconciler uses when the key is absent; a dash means there is none.

### Top level

| Key | Type | Required | Default | Description |
| --- | --- | --- | --- | --- |
| `projects` | array of object | yes | — | The repositories of your fleet, one entry for each. Two entries may name the same repository, for example one for documentation upkeep and one for code quality. |
| `dependencyEdges` | array of object | no | `[]` | Directed edges from an upstream repository to a downstream repository. Fan-in, fan-out and chains are valid; a cycle is refused. |
| `protectedFilesExclude` | array of string | no | `[]` | Files that drift and onboarding pull requests may change although gh-aw's protected-files policy would block them: base names, path prefixes, or exact paths and globs that start with `/`. Example: `["package.json"]`. |
| `engineApiKeySecret` | string | no | — | Name of the Actions secret that holds the API key of the AI engine. Required when the reconcile request uses `engineAuthMode` `api-key`, which is what the bootstrap command chooses for the `claude`, `codex`, `gemini` and `pi` engines. Example: `ANTHROPIC_API_KEY`. |
| `factory` | object | no | — | Where the factory package is installed in your repository and how jobs install it. This is the factory, not the AI engine. See [Private engine](private-engine.md). |
| `dedupe` | object | no | — | The fleet-wide convention for recognizing the pull requests of the target repositories' own scheduled workflows. |
| `onboarding` | object | no | — | What `sdlc-onboard` reads from a repository that it inspects. |
| `prompts` | object | no | — | Examples and wording that the rendered prompts take from you. |
| `state` | object | no | — | How the factory spells the sync-state variables that it writes. |

### Projects

| Key | Type | Required | Default | Description |
| --- | --- | --- | --- | --- |
| `projects[].projectKey` | string | yes | — | Short id: lower-case letters, digits and hyphens, at most 63 characters, unique in the manifest. It names the workflows `drift-<projectKey>` and `implement-<projectKey>`. Example: `docs-site`. |
| `projects[].repo` | string | yes | — | The repository as `<owner>/<repo>`. Example: `example-org/docs-site`. |
| `projects[].defaultBranch` | string | yes | — | The branch that holds the current state of the repository. Example: `main`. |
| `projects[].driftAudit` | object | yes | — | The scheduled upkeep of the repository. A project that needs none sets `enabled: false` and can still take part in edges. |
| `projects[].deconflictInRepoSchedules` | enum: `none`, `disable-workflow-schedules` | no | `none` | `disable-workflow-schedules` lets `sdlc-bootstrap --deconflict-upstream-schedules` disable the scheduled workflows named in `deconflictWorkflowIds`, so that a repository's own schedule and the fleet's do not both run. Nothing is disabled without that flag. Example: `none`. |
| `projects[].deconflictWorkflowIds` | array of string | no | `[]` | Workflow file names to disable. At least one is required when `deconflictInRepoSchedules` is `disable-workflow-schedules`, and none is allowed otherwise. Example: `["weekly-audit.yml"]`. |
| `projects[].autoMerge` | `false` only | no | — | Must be `false` when present: the fleet never merges a pull request. Example: `false`. |

### Drift audit

The scheduled upkeep of a project. Enabling it renders two workflows: `drift-<projectKey>`, which reads the watched sources and may open a pull request and file a drift report, and `implement-<projectKey>`, which turns a drift report into a pull request.

| Key | Type | Required | Default | Description |
| --- | --- | --- | --- | --- |
| `projects[].driftAudit.enabled` | boolean | yes | — | Turns the upkeep on. Example: `true`. |
| `projects[].driftAudit.schedule` | string | yes | — | When the upkeep runs: a five-field cron expression, in UTC. Example: `15 4 * * 2`. |
| `projects[].driftAudit.upkeepStrategy` | enum: `content-and-docs-sync`, `dependency-and-pattern-modernization`, `code-quality-and-improvement-scan`, `custom` | yes | — | What the agent does. The first three add a built-in prompt for that kind of upkeep (`content-and-docs-sync` keeps content and documentation in step with what the watched sources announce); `custom` uses only your instructions. Example: `content-and-docs-sync`. |
| `projects[].driftAudit.instructions` | string | yes | — | Registration instructions for the agent, inline. May be empty when `instructionsFile` is set; an enabled project needs one of the two. Example: `Keep the documentation in step with the product changelog.` |
| `projects[].driftAudit.instructionsFile` | string or null | yes | — | Path, relative to the repository root, of a Markdown file with the instructions: inside the repository and at most 512 KB. `null` for none. Example: `instructions/docs-site.md`. |
| `projects[].driftAudit.knowledgeSources` | object | yes | — | What the agent reads besides the repository. |
| `projects[].driftAudit.knowledgeSources.watchUrls` | array of object | yes | — | Pages that the agent is told to watch: changelogs, blogs, feeds. Each run saves a snapshot and compares it with the previous run. HTTPS only, no wildcard host; the hosts are added to the network allowlist of the agent. |
| `projects[].driftAudit.knowledgeSources.watchUrls[].url` | string | yes | — | The page. Example: `https://example.org/changelog`. |
| `projects[].driftAudit.knowledgeSources.watchUrls[].label` | string | yes | — | A short name for the source. Example: `Example changelog`. |
| `projects[].driftAudit.knowledgeSources.watchUrls[].kind` | enum: `changelog`, `blog`, `docs`, `release-notes`, `feed` | yes | — | What kind of page it is. Example: `changelog`. |
| `projects[].driftAudit.knowledgeSources.packageManifests` | array of string | yes | — | Globs of dependency manifests whose versions are snapshotted for the agent. Example: `["package.json"]`. |
| `projects[].driftAudit.knowledgeSources.mcpServers` | object | yes | — | MCP servers offered to the agent, passed to gh-aw as `mcp-servers`; see the gh-aw documentation for the entries it accepts. Example: `{}`. |
| `projects[].driftAudit.knowledgeSources.citedPages` | object | no | — | Documentation pages that the repository's own files cite. The snapshot step reads the repository files that match `include`, collects the URLs on the listed `hosts` that they cite, and snapshots the most cited pages. The hosts are added to the network allowlist of the agent. |
| `projects[].driftAudit.knowledgeSources.citedPages.include` | array of string | yes | — | Globs of the repository files to read for citations. Example: `["docs/**/*.md"]`. |
| `projects[].driftAudit.knowledgeSources.citedPages.hosts` | array of string | yes | — | Hosts whose pages count. Example: `["docs.example.org"]`. |
| `projects[].driftAudit.knowledgeSources.citedPages.maxPages` | integer | no | `50` | At most how many pages to snapshot, from 1 to 200. Example: `20`. |
| `projects[].driftAudit.buildCommands` | array of string | yes | — | Commands that the agent runs in the target checkout before it opens the pull request; their output is committed with its edits. Example: `["npm run build"]`. |
| `projects[].driftAudit.verifyCommands` | array of string | yes | — | Commands that run after the agent has finished, in the target checkout. A failure fails the run, and an enabled project needs at least one. Example: `["npm ci", "npm test"]`. |
| `projects[].driftAudit.draft` | boolean | yes | — | Open the pull requests as drafts. Example: `false`. |
| `projects[].driftAudit.reviewers` | array of string | yes | — | GitHub logins to request as reviewers. Example: `["example-reviewer"]`. |
| `projects[].driftAudit.dedupe` | object | no | — | The same keys as the top-level `dedupe`. For this project it replaces the fleet's block; the two are not merged. |
| `projects[].driftAudit.stagedScripts` | array of string | no | `[]` | Workspace-relative `.mjs` scripts that the verify commands run. See [staged scripts](#staged-scripts). Example: `["scripts/validate-docs.mjs"]`. |
| `projects[].driftAudit.agentSandbox` | object | no | — | What the agent has inside its sandbox besides git, node and the executables of the build commands. |
| `projects[].driftAudit.agentSandbox.installDependencies` | boolean | no | `false` | Run `npm ci --ignore-scripts` in the target checkout before the agent starts, so that the validators it runs find their packages: the sandbox has no route to the package registry. Example: `true`. |
| `projects[].driftAudit.agentSandbox.bashCommands` | array of string | no | `[]` | Executables, as bare names, to add to the bash allowlist of the agent. `curl`, `gh` and `wget` are refused: the agent publishes only through its safe outputs. Example: `["jq"]`. |

### Edges

An edge follows an upstream repository and delivers its changes to a downstream repository as a pull request. A `mechanical` edge runs the import commands and nothing else; an `ai-adaptation` edge lets an agent adapt the downstream, behind the [immutable gates](#immutable-gates). The downstream must have the same owner as your orchestrator repository, because one App installation token is scoped to one owner.

| Key | Type | Required | Default | Description |
| --- | --- | --- | --- | --- |
| `dependencyEdges[].edgeId` | string | yes | — | Short id, unique. It names the workflow `cascade-mechanical-<edgeId>` or `cascade-ai-<edgeId>`. Example: `docs-to-hub`. |
| `dependencyEdges[].mode` | enum: `mechanical`, `ai-adaptation` | yes | — | `mechanical` runs `importCommands`; `ai-adaptation` hands the change to an agent. Example: `mechanical`. |
| `dependencyEdges[].upstreamRepo` | string | yes | — | The repository that changes, as `<owner>/<repo>`. Example: `example-org/docs-site`. |
| `dependencyEdges[].upstreamKey` | string | yes | — | Short id of the upstream for the router, unique among edges: lower-case letters, digits and hyphens. Example: `docs-site`. |
| `dependencyEdges[].upstreamSlug` | string | yes | — | Upper-case id (A-Z, digits and `_`, at most 64) that completes the name of the state variable. Example: `DOCS_SITE`. |
| `dependencyEdges[].upstreamDefaultBranch` | string | yes | — | The upstream branch that the router follows. Example: `main`. |
| `dependencyEdges[].initialBaselineSha` | string | yes | — | The upstream commit that the downstream already reflects when the state variable is first created: 40 lowercase hexadecimal characters. Example: `0123456789abcdef0123456789abcdef01234567`. |
| `dependencyEdges[].downstreamRepo` | string | yes | — | The repository that receives the pull requests, as `<owner>/<repo>`. Example: `example-org/hub`. |
| `dependencyEdges[].schedule` | string or null | yes | — | Five-field cron, in UTC, on which the router polls this upstream. `null` for none: the router then acts only on a `repository_dispatch` event or a manual run. Example: `0 */6 * * *`. |
| `dependencyEdges[].onCommitOnlyAdvance` | enum: `noop`, `bump-provenance` | yes | — | What to do when the upstream moved but nothing that matters changed: `noop` does nothing, `bump-provenance` opens a pull request that only records the new revision in the provenance file. Example: `noop`. |
| `dependencyEdges[].stateVariable` | string | yes | — | Name of the Actions variable that holds the [sync state](architecture.md#sync-state) of this upstream. It must be `SDLC_SYNC_STATE_` followed by `upstreamSlug`. Example: `SDLC_SYNC_STATE_DOCS_SITE`. |
| `dependencyEdges[].provenanceFile` | string | yes | — | File in the downstream that records the upstream commit it reflects. Example: `provenance.json`. |
| `dependencyEdges[].provenanceJsonPointer` | string | yes | — | JSON pointer to that commit inside the file. Example: `/commit`. |
| `dependencyEdges[].branchName` | string | yes | — | Branch of the cascade pull request, unique among edges. Example: `sdlc/cascade-docs-to-hub`. |
| `dependencyEdges[].closeOlderKey` | string | yes | — | Marker that lets a newer pull request of this edge close the older one, unique among edges. Example: `sdlc-cascade-docs-to-hub`. |
| `dependencyEdges[].reviewers` | array of string | yes | — | GitHub logins to request as reviewers; at least one. Example: `["example-reviewer"]`. |
| `dependencyEdges[].importCommands` | array of string | yes | — | Mechanical edges: commands that bring the upstream into the downstream checkout, run from its root. `<checkout>` is the upstream checkout. Example: `["node scripts/import.mjs <checkout>"]`. |
| `dependencyEdges[].preflightCommands` | array of string | yes | — | AI edges: commands that capture evidence for the agent. The router also runs them to decide whether anything that matters changed: exit code 0 means no drift, 1 means drift, anything else is a failure. Example: `["git -C <checkout> diff --quiet \"$LAST_MERGED_SHA\" \"$TARGET_SHA\""]`. See [preflight checks](#preflight-checks). |
| `dependencyEdges[].acceptCommands` | array of string | yes | — | AI edges: deterministic commands that the agent runs after its edits and before the build commands. Example: `["npm run sync"]`. |
| `dependencyEdges[].buildCommands` | array of string | yes | — | Commands that build the downstream. In an AI edge the agent runs them after its edits and commits their output with the change. In a mechanical edge they run after the import, as a check of the committed tree. Example: `["npm run build"]`. |
| `dependencyEdges[].verifyCommands` | array of string | yes | — | Commands run in the downstream checkout after the agent or the import has finished. A failure fails the run. Example: `["npm test"]`. |
| `dependencyEdges[].adaptationInstructions` | string | yes | — | Instructions for the agent of an AI edge. Use an empty string on a mechanical edge. Example: `Adapt the hub pages to the changed lab content.` |
| `dependencyEdges[].allowedFiles` | array of string | yes | — | Globs of the downstream files that the pull request may change. Any other changed file refuses the pull request, and no entry may include a path of `immutableGates.zeroDiffPaths`. At least one. Example: `["site/**"]`. |
| `dependencyEdges[].protectedFilesExclude` | array of string | yes | — | Files that this edge's pull request may change although gh-aw's protected-files policy would block them. Example: `["package.json"]`. |
| `dependencyEdges[].maxPatchFiles` | integer | no | — | Largest number of files that one pull request of this edge may change; at least 1. gh-aw's own limit is 100 when this is absent. Example: `40`. |
| `dependencyEdges[].autoMerge` | `false` only | yes | — | Must be `false`: the fleet never merges a pull request. Example: `false`. |
| `dependencyEdges[].syncScopes` | array of string | no | — | The scopes that this edge's workflow accepts as its `sync_scope` input, each an id of your choosing (lower-case letters, digits and hyphens). `both`, meaning everything the edge syncs, is reserved and is the only scope when this is absent. Example: `["both", "content-only"]`. |
| `dependencyEdges[].preflightChecks` | array of object | no | — | How the router decides each `preflightCommands` entry, one entry for each command and in the same order. See [preflight checks](#preflight-checks). |
| `dependencyEdges[].preflightChecks[].scope` | string | no | — | The scope that a drift of this command asks the dispatch for. It must be one of `syncScopes`. Example: `content-only`. |
| `dependencyEdges[].preflightChecks[].classifier` | string | no | — | A command that decides from what the check printed, instead of its exit code. See [preflight checks](#preflight-checks). Example: `node scripts/classify-report.mjs`. |
| `dependencyEdges[].preflightChecks[].noopAction` | enum: `noop-no-material-drift`, `noop-unchanged-snapshot` | no | — | How an unchanged result is recorded. The default is `noop-no-material-drift`. Example: `noop-unchanged-snapshot`. |
| `dependencyEdges[].logProvenance` | array of object | no | — | Other provenance files of the downstream whose commit the router logs beside `provenanceFile`. A difference is logged and never acted on. |
| `dependencyEdges[].logProvenance[].file` | string | yes | — | The file, relative to the downstream root. Example: `data/sources.json`. |
| `dependencyEdges[].logProvenance[].pointer` | string | yes | — | JSON pointer to the commit inside the file. Example: `/_provenance/commit`. |
| `dependencyEdges[].installDirectories` | array of string | no | — | Directories of the downstream checkout, relative to its root, in which a cascade workflow runs `npm ci --include=dev`. The root only when absent. Example: `[".", "apps/site"]`. |
| `dependencyEdges[].pythonVersion` | string | no | — | Python version for a Python downstream. When set, setup installs Python and runs `pip install -e .[dev]` instead of `npm ci`. Example: `3.12`. |
| `dependencyEdges[].nodeVersion` | string | no | — | Node.js version that the cascade workflow sets up, as `24`, `22.11` or `22.11.0`. `24` when absent; ignored when `pythonVersion` is set. Example: `22`. |
| `dependencyEdges[].setupSteps` | array of object | no | `[]` | Extra setup that the cascade workflow runs after the dependency installs, in the order listed, for the Node and the Python path alike. |
| `dependencyEdges[].setupSteps[].name` | string | yes | — | The step's name. Example: `Install the browser`. |
| `dependencyEdges[].setupSteps[].run` | string | yes | — | The command. Example: `npx playwright install --with-deps chromium`. |
| `dependencyEdges[].setupSteps[].workingDirectory` | string | no | — | A directory of the downstream checkout; the checkout itself when absent. Example: `apps/site`. |

#### Preflight checks

Before it dispatches an AI-adaptation workflow, the router runs the edge's `preflightCommands` in a checkout of the upstream at the new revision, with `UPSTREAM_DIR`, `TARGET_SHA` and `LAST_MERGED_SHA` set. By default the exit code decides: 0 means nothing material changed, 1 means drift, and anything else fails the router job.

A `classifier` replaces that rule for one command. It is a command that only the router runs, in the same directory and with the same scrubbed environment as the check, plus `SDLC_PREFLIGHT_INDEX`, `SDLC_PREFLIGHT_COMMAND`, `SDLC_PREFLIGHT_EXIT_CODE`, `SDLC_PREFLIGHT_STDOUT_FILE` and `SDLC_PREFLIGHT_STDERR_FILE`. Its own exit code is the verdict, by the same rule. If the drifted checks name one scope the router asks for it, if they name different scopes it asks for `both`, and if they name none it asks for the default.

Before any command runs, the router looks for the script that a command starts. A command or a classifier that begins `node [options] <script>`, where the script is a `.mjs`, `.cjs`, `.js`, `.mts`, `.cts` or `.ts` file that is named plainly (relative to the directory that the command runs in, or under `$GITHUB_WORKSPACE` or `$UPSTREAM_DIR`), has to name a file that exists. When it does not, the router job fails and names the missing file: node exits 1 for a file that is not there, and exit code 1 is drift, so without this check the router would dispatch a cascade for an orchestrator that lacks a helper that its manifest declares. A path that the shell would have to expand first (another variable, a substitution, a glob or `~`), an absolute path, a file of another kind and a command that does not start with `node` are not checked; their exit code decides.

### Immutable gates

After an AI agent has finished, `verify-immutable-gates` decides whether its commits left the downstream's own guard rails as they were. Everything it enforces comes from this block.

| Key | Type | Required | Default | Description |
| --- | --- | --- | --- | --- |
| `dependencyEdges[].immutableGates` | object | yes | — | The guard rails of the edge. Mechanical edges still need the block; they use `zeroDiffPaths: []`. |
| `dependencyEdges[].immutableGates.zeroDiffPaths` | array of string | yes | — | Paths and globs that must not differ from the base revision: the downstream's rules, runtime and sandbox files. Example: `["kernel"]`. |
| `dependencyEdges[].immutableGates.generatedPaths` | array of string | no | `[]` | Globs of files that the downstream generates, such as committed build output. They are not editable modules, so the constructs that the gate bans are not looked for in them. Example: `["dist/**"]`. |
| `dependencyEdges[].immutableGates.lockedTestBlocks` | any | no | — | Free-form data of the gate: a list of `{ file, blocks, lockedImports }`, where `blocks` holds `{ kind, title }` entries (`it` or `describe`) of that test file that must stay byte for byte as they were. Example: `[{ file: tests/rules.test.ts, blocks: [{ kind: describe, title: Rules }] }]`. |
| `dependencyEdges[].immutableGates.inProcessInvariants` | any | no | — | Free-form data of the gate: the modules that it loads and freezes in its own process and the checks that it calls (`frozenModules`, `course`, `check`, `constants`, `customerTerms`). Example: `{ frozenModules: [kernel/rules.ts] }`. |

### Adaptation

| Key | Type | Required | Default | Description |
| --- | --- | --- | --- | --- |
| `dependencyEdges[].adaptation` | object | no | — | Data of an `ai-adaptation` edge that the factory and your helper scripts read. A mechanical edge may not have it. |
| `dependencyEdges[].adaptation.preflightReports` | array of string | no | — | File names, under the artifact directory of the run, of the reports of the `preflightCommands`: one for each command and in the same order. Each report is also kept as `preflight-<n>.txt`. Example: `["drift.txt"]`. |
| `dependencyEdges[].adaptation.helpers` | object | no | — | Data of your own helper scripts, one entry for each helper under a name of your choosing. The factory does not read it: a helper script reads its entry with `helperSection(document, name)` from [`ai-sdlc-factory/script-kit`](api.md#ai-sdlc-factoryscript-kit), which refuses edges that declare the same helper differently. Example: `{ sourceCheck: { manifest: data/sources.json } }`. |
| `dependencyEdges[].adaptation.pullRequestResult` | object | no | — | Globs of the changed files that the pull-request result reports, by a name of your choosing (a letter followed by letters and digits; not `outcome`, `prNumber`, `prUrl` or `recordedCommit`). The result has one array for each key, in this order, with the sorted base names of the matches. Example: `{ pages: "site/pages/**" }`. |

### Factory

See [Private engine](private-engine.md) for what the install steps look like.

| Key | Type | Required | Default | Description |
| --- | --- | --- | --- | --- |
| `factory.package` | string | yes | — | The npm dependency of your repository that holds the factory. It has to be listed in your `package.json`. Example: `ai-sdlc-factory`. |
| `factory.source` | string | no | — | `github:<owner>/<repo>` of the factory repository, the one that the install token is minted for. No ref: `package.json` and the lockfile pin the version. Required when `private` is `true`. Example: `github:<owner>/ai-sdlc-factory`. |
| `factory.private` | boolean | no | `false` | `true` while the factory repository is private: every job that installs it mints a read token for it and rewrites npm's git URLs for that repository. `false` once it is public: the install is a plain `npm ci --ignore-scripts`. Example: `true`. |
| `factory.dir` | string | no | — | Where the package is installed, relative to the repository root. `node_modules/<package>` when absent; `.` means the repository itself. Letters, digits and `._@/-` only. Example: `node_modules/ai-sdlc-factory`. |

Without a `factory` block, or with `dir: "."`, the factory is taken to be in the repository itself, and every workflow runs its scripts from `$GITHUB_WORKSPACE/src`.

### State

| Key | Type | Required | Default | Description |
| --- | --- | --- | --- | --- |
| `state.dialect` | enum: `preserve`, `legacy`, `downstream` | no | `preserve` | How the fourth field of the [sync state](architecture.md#sync-state) is spelled when the factory writes it. `preserve` writes the name that it read. `legacy` always writes `portfolioMainSha`, which code that predates the new name can read. `downstream` always writes `downstreamMainSha`, and each variable converts on its next write; set it only when nothing that reads the variable expects the legacy spelling. New variables are seeded in the legacy spelling unless this is `downstream`. Example: `downstream`. |

### Dedupe

| Key | Type | Required | Default | Description |
| --- | --- | --- | --- | --- |
| `dedupe.upkeeps` | array of object | no | `[]` | The upkeeps of the target repositories' own schedules. A pull request whose head branch starts with one of an upkeep's `branchPrefixes`, or that carries one of its `labels`, is a possible duplicate and belongs to that upkeep. |
| `dedupe.upkeeps[].id` | string | yes | — | Id of the upkeep, unique in the block: lower-case letters, digits and hyphens. Example: `weekly-audit`. |
| `dedupe.upkeeps[].branchPrefixes` | array of string | no | `[]` | Head branch prefixes of the upkeep's pull requests. Example: `["automation/weekly-audit-"]`. |
| `dedupe.upkeeps[].labels` | array of string | no | `[]` | Labels that mark its pull requests. Example: `["content-audit"]`. |
| `dedupe.strategyUpkeep` | object | no | — | Which upkeep each `upkeepStrategy` does, by upkeep id. A workflow whose strategy is not listed has no upkeep, so it treats every pull request that is not its own as a possible duplicate. |
| `dedupe.strategyUpkeep.content-and-docs-sync` | string | no | — | The upkeep id of the `content-and-docs-sync` strategy. Example: `weekly-audit`. |
| `dedupe.strategyUpkeep.dependency-and-pattern-modernization` | string | no | — | The upkeep id of the `dependency-and-pattern-modernization` strategy. Example: `modernize`. |
| `dedupe.strategyUpkeep.code-quality-and-improvement-scan` | string | no | — | The upkeep id of the `code-quality-and-improvement-scan` strategy. Example: `quality-scan`. |
| `dedupe.strategyUpkeep.custom` | string | no | — | The upkeep id of the `custom` strategy. Example: `custom-upkeep`. |

The factory's own `sdlc/` branches are always candidates. Without a `dedupe` block no other pull request is a candidate, and every match is a possible duplicate.

### Prompts

| Key | Type | Required | Default | Description |
| --- | --- | --- | --- | --- |
| `prompts.reportExamples` | array of string | no | `[]` | Reports that a drift or implementation prompt names as examples of the report that your registration instructions may define, as plain relative paths. None: the prompt names no example. Example: `["docs/audit-report.md"]`. |
| `prompts.pullRequestBodyItems` | string | no | `the adapted files` | What the body of an AI-adaptation pull request lists besides the range of commits and the correlation id, as one line of prose (at most 200 characters). Example: `the adapted pages`. |

### Onboarding

| Key | Type | Required | Default | Description |
| --- | --- | --- | --- | --- |
| `onboarding.provenanceNames` | array of string | no | — | The base names of the files that an inspection takes for a provenance file, at any depth, with no directory part. `["source.json", "provenance.json"]` when absent; an empty list means that no file is one. Example: `["source.json", "provenance.json"]`. |

## Staged scripts

A verify command can run a script of your own that checks what the agent did. The agent can edit the workspace, so the script has to be protected from it. `stagedScripts` lists such scripts. Before the agent starts, `prepare-run` copies them, together with the factory's `src/drift/lib` and `package.json`, into a read-only directory (`${RUNNER_TEMP}/gh-aw/sdlc-validator`), in a layout that mirrors the workspace. The command that verifies compares the workspace copy of the script, of the factory's `package.json` and of `src/drift/lib` with the staged one, refuses a `node_modules` directory beside the script, and then runs the **staged** copy, not the workspace one. Node finds what `ai-sdlc-factory/drift-lib` is from where the script is, and in the workspace a `package.json` that names itself `ai-sdlc-factory` (in the script's directory or at the root), or a package under `node_modules`, would be found first and no comparison of files would see it. The stage holds nothing else, so a staged script may import only `ai-sdlc-factory/drift-lib` and `node:` modules. `examples/sdlc.yaml` has the command in full. A project that declares none stages nothing.

## Checks beyond the schema

The reconciler also refuses a manifest for these reasons. The rule id is the text before the colon in its message.

| Rule | Refused when |
| --- | --- |
| `duplicate-project-key`, `duplicate-edge-id`, `duplicate-branch-name`, `duplicate-close-older-key`, `duplicate-upstream-key`, `duplicate-state-variable` | two entries use the same value of the key that the rule names. |
| `edge-state-variable` | `stateVariable` is not `SDLC_SYNC_STATE_` followed by `upstreamSlug`. |
| `dependency-cycle` | the edges form a cycle between repositories. |
| `edge-reviewers-empty`, `edge-allowed-files-empty` | `reviewers` or `allowedFiles` of an edge is empty. |
| `command-blank` | a command is empty or only white space. |
| `edge-preflight-checks-count` | `preflightChecks` does not have one entry for each `preflightCommands` entry. |
| `edge-preflight-scope-undeclared` | a check's `scope` is not one of the edge's `syncScopes`. |
| `allowed-files-locked-path` | an `allowedFiles` entry includes a path of `immutableGates.zeroDiffPaths`. |
| `edge-adaptation-mode` | a mechanical edge has an `adaptation` block. |
| `edge-preflight-reports-count`, `edge-preflight-reports-reserved` | `preflightReports` does not have one name for each preflight command, or a name is one that the workflow writes for itself. |
| `drift-instructions-file`, `drift-instructions-missing` | `instructionsFile` cannot be read as a file inside the repository, or an enabled project has no instructions. |
| `drift-strategy-fragment` | the built-in prompt for the strategy cannot be read. |
| `drift-watch-url-invalid` | a watched URL is not an absolute HTTPS URL, or has a wildcard host. |
| `drift-verify-commands-missing` | an enabled project has no runnable verify command. |
| `drift-bash-command-forbidden` | `agentSandbox.bashCommands` lists `curl`, `gh` or `wget`. |
| `dedupe-upkeep-duplicate`, `dedupe-strategy-upkeep-unknown` | an upkeep id is used twice in a block, or `strategyUpkeep` names an upkeep that the block does not declare. |
| `factory-source-required` | `factory.private` is `true` and there is no `source`. |
| `factory-dir-invalid` | `factory.dir` is not a plain repository-relative path, or `private` is `true` while the directory is the repository itself. |
| `factory-dependency-missing` | your `package.json` has no dependency named `factory.package`, so `npm ci` would not install it. |
| `engine-api-key-secret-missing` | the request uses `engineAuthMode` `api-key` and `engineApiKeySecret` is not set. |
| `manifest-expression-opener` | a string contains `${{`. |
| `manifest-path-invalid` | the manifest is outside the repository, or its path cannot be passed to a workflow step. |
