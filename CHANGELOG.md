# Changelog

All notable changes to this project are documented in this file.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html). Before 1.0.0 a minor release may break the manifest schema; every break is listed under **Breaking**, with the steps to follow under **Migration**.

## [0.2.0] - 2026-11-24

The drift, implementation and AI-adaptation agents act on what they find instead of deferring it, and the manifest gains a policy, a model and a sandbox for them. Every new key is optional.

### Added

- **`projects[].driftAudit.changePolicy`**: which changes the drift and implementation agents of a project make themselves, and which they leave for a human. One of:
  - `corrections-only` (the default): only corrections, where a corroborated source contradicts the repository. Source-backed additions (content that the sources announce and the repository does not cover yet) and judgement calls are applied by neither workflow.
  - `corrections-and-additions`: also additions, such as a new feature, setting, limit or retirement that deserves a lab step, a slide or a reference note. Judgement calls stay for a human.
  - `judgement-and-flag`: also judgement calls. A pull request that makes one has a `## Judgement calls — review these` heading that lists each of them with the files changed, the source and the alternatives considered.

  See [change policies](docs/manifest.md#change-policies).
- **`## For a human` in the drift report**, under `corrections-only` and `corrections-and-additions`: a list of what the policy leaves for a reviewer. It is omitted when it would be empty, and the drift run files a report for it even when nothing else qualifies. The implementation workflow leaves it alone: a report with nothing under `## Recommended` or `## Could not confirm` ends without a pull request.
- **`projects[].driftAudit.model` and `dependencyEdges[].model`**: the model of the agent, rendered as the `model` field of the gh-aw engine object (`engine: { id: copilot, model: opus }`), whichever engine the request selects. The implementation workflow of a project uses the model of its drift workflow. Without the key nothing is rendered and the engine chooses its own, as before.
- **`dependencyEdges[].agentSandbox.bashCommands`**: executables, as bare names, that the agent of the edge's cascade workflow may run besides its default list. The `drift-bash-command-forbidden` rule now refuses `curl`, `gh` and `wget` here too.

### Changed

- **The drift and implementation prompts agree on what is actionable.** A drift report used to list additions and judgement calls under `## Recommended`, which starts an implementation run, and that run was told to leave exactly those alone. Both prompts are now rendered from the policy of the project, so `## Recommended` holds what the implementation applies. With no `changePolicy`, additions and judgement calls move from `## Recommended` to the new `## For a human`.
- **The `content-and-docs-sync` guidance** now reads "keep them in step with what a corroborated source supports", where it said "update only what a corroborated source contradicts": the policy decides what that covers, not the guidance. A project that keeps its own `prompts/drift/strategy-content-and-docs-sync.md` is unchanged.
- **The implementation run opens every source.** It opens the source of every `## Recommended` and `## Could not confirm` item before it decides the item, and leaves one undecided only on a fetch failure whose error it quotes. It used to be allowed to skip an item whose page it had not opened, as long as it said so.
- **The agent of an AI-adaptation cascade may run `cd`**, which its prompt tells it to start its commands with, and its prompt now says that the shell refuses a redirection or a heredoc, so files are written with the edit tool.

### Fixed

- **`sdlc-bootstrap` and `sdlc-onboard` accept a manifest or an `--instructions` file reached through a symbolic link or a Windows 8.3 short path.** They compared the working copy that git reports, which is canonical, with the path as it was given, and refused such a file as outside the repository (`manifest-path-invalid`, or `--instructions … names a file outside the working copy`). Both paths are now resolved to their canonical form first.

### Migration

Existing manifests remain schema-valid without edits, and the default `changePolicy` (`corrections-only`) applies to every upkeep strategy. A project whose instructions ask its agents for more than corrections (new content, upgrades, improvements) sets `changePolicy: corrections-and-additions`, or `judgement-and-flag` to have them make judgement calls as well.

Run `sdlc-reconcile` and commit the regenerated workflows: the prompts and lock metadata of the drift, implementation and AI-adaptation workflows differ, and the locks of the AI-adaptation workflows also allow `cd`.

## [0.1.0] - 2026-11-19

The first release: the renderer, the reconciler and the bootstrap and onboarding commands, packaged as an npm dependency that an orchestrator repository installs at a release tag.

### Added

- **The package.** `ai-sdlc-factory` is installed as a git dependency (`github:<owner>/ai-sdlc-factory#v0.1.0`); the lockfile pins the commit. It installs three commands: `sdlc-bootstrap`, `sdlc-onboard` and `sdlc-reconcile`, which renders and compiles the workflows from a request file.
- **The `factory` manifest block** (`package`, `source`, `private`, `dir`): where the factory runs from and how a job installs it. With no block, the factory is taken to be in the repository itself. With `private: true`, every job that installs the factory first mints a read token for that one repository from the GitHub App and installs under three `GIT_CONFIG_*` URL rewrites in the environment of that step; with `private: false` the install step is a plain `npm ci --ignore-scripts`. `sdlc-bootstrap` requires the App to be installed on a private factory repository. New reconciler rules: `factory-source-required`, `factory-dir-invalid` and `factory-dependency-missing`. See [Installing a private factory](docs/private-engine.md).
- **`SDLC_MANIFEST`**: the manifest can live at any workspace-relative `.yaml` or `.yml` path. The reconciler passes it on to the rendered steps that read the manifest when it is not `sdlc.yaml`.
- **Public API**: `ai-sdlc-factory/script-kit` (for the scripts of an orchestrator), `ai-sdlc-factory/drift-lib` (the part that can be staged read-only), `ai-sdlc-factory/reconcile` (`renderFleet`, `reconcile`, `checkRendered`, `buildAcks`), `ai-sdlc-factory/schemas/*` and `ai-sdlc-factory/package.json`. See [Public API](docs/api.md).
- **Manifest keys** that keep the conventions of your fleet in its manifest, not in the factory:
  - `dependencyEdges[].syncScopes`: free-form scope ids (`both` stays the default);
  - `dependencyEdges[].preflightChecks` (`scope`, `classifier`, `noopAction`) and `dependencyEdges[].logProvenance`;
  - `dedupe` (fleet-wide, or `projects[].driftAudit.dedupe` for one project): the branch prefixes and labels of the target repositories' own scheduled workflows;
  - `projects[].driftAudit.stagedScripts`: the scripts that are staged read-only for a verify command;
  - `dependencyEdges[].nodeVersion` and `dependencyEdges[].setupSteps`;
  - `dependencyEdges[].immutableGates.generatedPaths`;
  - `dependencyEdges[].adaptation.helpers` (opaque data for your helper scripts, read with `helperSection`) and a free-form `adaptation.pullRequestResult` map;
  - `prompts.reportExamples` and `prompts.pullRequestBodyItems`;
  - `onboarding.provenanceNames`;
  - `state.dialect`.
- **Sync state dialect.** The fourth field of the state variable has two spellings: `downstreamMainSha`, which the factory uses, and the legacy `portfolioMainSha`. The factory reads either, writes the one that it read (`state.dialect: preserve`, the default), and converts a variable only when you set `state.dialect: downstream`. New variables are seeded with the legacy name unless you set `downstream`. See [Architecture](docs/architecture.md#the-state-dialect).
- **Leak guard** (`tools/leak-guard`): generic rules and a SHA-256 digest denylist, over the tracked tree (`--tree`), the whole history including commit metadata and the name, tagger and message of every tag (`--history`), or as counts (`--report`). It runs in `npm test` and in CI. It finds a term:
  - in the spellings that code has: any case, any separator or none, camelCase, with digits attached, and glued to other letters;
  - when a line break cuts it in two, in a file, in a commit or tag message and in a diff;
  - when it is percent-encoded, written as a `\u` or `\x` escape or as an HTML entity, up to two layers deep;
  - in the printable strings of a binary file, and of a binary blob in the history.

  The denylist holds no e-mail address, because the generic rules stop every one. An exception for a token-shaped constant in a file names the lines that it waives.
- **`tools/render-diff.mjs`**: a harness that proves that two renders of one fleet (or two sets of compiled locks) differ only by the classes that a change is allowed to make, each class counted against its own pattern. It understands the validator comparison of a staged script in both of its spellings, the one that names the factory's sources in the repository's own `src/` and the one that names a directory of its own, at every stage.
- **`aw.yml` and `payload/`**: the repository is a gh-aw package whose mapping include installs a seed of the onboarding workflow, rendered by the factory's own `renderOnboardPayload()` and regenerated with `node tools/update-payload.mjs`.
- **`examples/`**: a synthetic reference preset, built to exercise every feature of the factory, whose committed workflows are the golden output of the renderer; `node tools/update-examples.mjs --compile` regenerates it.
- **CI** (`.github/workflows/ci.yml`): tests on Linux with Node.js 22 and 24 for every push, pull request, release tag and manual run, and on Windows with Node.js 24 for pull requests, release tags and manual runs (a push to `main` leaves out Windows, the slowest leg), the leak guard, the examples drift check with the real gh-aw, a packaging check and a consumer smoke test.
- **Documentation**: README, manifest reference, architecture, private-factory install and public API.

### Deprecated

- `--portfolio`, the old name of `--downstream` in `verify-immutable-gates`. It is still accepted, with a notice on standard error, until 0.3.0; giving both is a usage error.
- Reading `portfolioMainSha`, the `state` block and the state dialect, until 1.0.0.
