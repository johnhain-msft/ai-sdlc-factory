# Changelog

All notable changes to this project are documented in this file.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html). Before 1.0.0 a minor release may break the manifest schema; every break is listed under **Breaking**, with the steps to follow under **Migration**.

## [Unreleased]

### Fixed

- **`sdlc-bootstrap` and `sdlc-onboard` accept a manifest or an `--instructions` file reached through a symbolic link or a Windows 8.3 short path.** They compared the working copy that git reports, which is canonical, with the path as it was given, and refused such a file as outside the repository (`manifest-path-invalid`, or `--instructions … names a file outside the working copy`). Both paths are now resolved to their canonical form first.

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
