# ai-sdlc-factory

The factory keeps a fleet of GitHub repositories current with agentic workflows. You describe the fleet once in a manifest (`sdlc.yaml`): the repositories to keep up to date, and the edges along which a change in one repository must reach another. The factory renders that manifest into [gh-aw](https://github.github.com/gh-aw/) workflows, compiles them in strict mode, and keeps them in step with it: scheduled upkeep of each repository, and pull requests that carry an upstream change to its downstream repositories, mechanically or adapted by an agent behind guard rails. It acts through a GitHub App, merges nothing, and installs into your own orchestrator repository as an npm dependency.

- [Manifest reference](docs/manifest.md)
- [Architecture](docs/architecture.md)
- [Installing a private factory](docs/private-engine.md)
- [Public API](docs/api.md)
- [Changelog](CHANGELOG.md) and [security policy](SECURITY.md)

## Prerequisites

- **Node.js 22 or newer** and **git**.
- **GitHub CLI (`gh`) with the gh-aw extension, version 1.0.1 or newer.** Install it with `gh extension install github/gh-aw`, or upgrade it with `gh extension upgrade gh-aw`, and check it with `gh aw version`.
- A GitHub account that can register a GitHub App, or an App that you already have, and admin rights on your orchestrator repository to set its variables and secrets.
- An account for the AI engine that you choose with `--engine`: Copilot (the default), Claude, Codex, Gemini or Pi.

**Why gh-aw 1.0.1.** Advisory `GHSA-8h78-hpm7-29gg` affects gh-aw `>= 0.83.3` and `< 0.85.4`: those releases wrote raw process output into the `safe-outputs-items` artifact, which can expose CI trigger tokens. The fix is in 0.85.4. This project requires 1.0.1, which is the floor it chose. `sdlc-bootstrap` and `sdlc-onboard` refuse to run with an older gh-aw, and a reconcile request has to carry a baseline of 1.0.1. Upgrading the CLI is not enough: existing `.lock.yml` files keep the SHA-pinned action references of the release that compiled them, so run `gh aw upgrade` and commit the regenerated `.lock.yml` files.

If your global `gh aw` is older and you cannot replace it, install 1.0.1 or newer into a separate directory and point `SDLC_GH_AW_DATA_HOME` at it. The commands then use it as `XDG_DATA_HOME` unless you have set that yourself.

## Install

The factory is not a template to fork. Your orchestrator repository is an ordinary repository that holds the manifest and the generated workflows, and that depends on the factory.

1. Create the orchestrator repository, clone it, and make sure that its `origin` remote points at GitHub: the commands take the repository from `origin`.
2. Add the factory as a dependency, at a release tag. `<owner>` is the account that hosts the factory repository.

   ```json
   {
     "name": "my-orchestrator",
     "private": true,
     "dependencies": {
       "ai-sdlc-factory": "github:<owner>/ai-sdlc-factory#v0.2.0"
     }
   }
   ```

   Run `npm install --ignore-scripts` and commit `package.json` and `package-lock.json`. The lockfile records the commit that the tag pointed at, and `npm ci` installs that commit, whatever happens to the tag later. If the factory repository is private, npm needs a credential for this one command; see [Updating](#updating).

3. Add a manifest, `sdlc.yaml`, with the `factory` block. An empty fleet is a valid start; `sdlc-onboard` adds repositories to it.

   ```yaml
   factory:
     package: ai-sdlc-factory
     source: github:<owner>/ai-sdlc-factory
     private: true
   state:
     dialect: downstream
   projects: []
   dependencyEdges: []
   ```

   Set `private: false` when the factory repository is public. The `factory` block says where the package is installed and whether the workflows need a token to install it. `state.dialect: downstream` makes the sync-state variables use the current field name (see [the state dialect](docs/architecture.md#the-state-dialect)).

4. Run [`sdlc-bootstrap`](#sdlc-bootstrap), then [`sdlc-onboard`](#sdlc-onboard) for each repository.

### Private factory

While the factory repository is private, every workflow job that installs it mints a read token for that one repository from your GitHub App and installs with `npm ci --ignore-scripts` under three `GIT_CONFIG_*` URL rewrites, set in the environment of that step only. For that to work:

- your App must be installed on the factory repository with `Contents` read (`sdlc-bootstrap` checks this when `factory.private` is `true`), and
- the manifest must say `private: true` and name `source`.

[Installing a private factory](docs/private-engine.md) shows the rendered steps and the ways it can fail. When the factory repository becomes public, set `factory.private: false` and run `sdlc-reconcile`: the token step and the rewrites disappear and the install step is a plain `npm ci --ignore-scripts`.

## Commands

The package installs three commands. Run them from the root of your orchestrator repository with `npx`. `sdlc-bootstrap` and `sdlc-onboard` print progress on standard error and one JSON document on standard output; `sdlc-reconcile` prints its result as JSON. The exit code is 0 on success and 1 on a failure; `sdlc-bootstrap` and `sdlc-onboard` use 2 for a usage error. None of them accepts a secret as a flag.

### sdlc-bootstrap

```text
npx sdlc-bootstrap [--manifest sdlc.yaml] [--owner <user-or-org>] [--app-name <up to 34 characters>]
  [--engine copilot|claude|codex|gemini|pi] [--deconflict-upstream-schedules] [--non-interactive]
```

One command turns the orchestrator repository into a running one. In order, it:

1. checks that gh-aw is 1.0.1 or newer;
2. reads the manifest and resolves the orchestrator repository from `origin`;
3. registers a GitHub App through GitHub's manifest flow in your browser, or uses the one that `APP_CLIENT_ID` and `APP_PRIVATE_KEY` name, and checks that its permissions stay within a fixed ceiling;
4. checks, for up to ten minutes, that the App is installed with the required permissions on every repository that it needs, and after a new registration sends you to the installation page of each account;
5. sets the Actions variable `APP_CLIENT_ID` and one `SDLC_SYNC_STATE_<SLUG>` variable for each edge (it creates a state variable only when it does not exist, and never changes an existing one);
6. sets the secret `APP_PRIVATE_KEY` and the credential of the engine you chose, if it has one;
7. with `--deconflict-upstream-schedules`, disables the in-repository schedules that the manifest names, with your own credentials;
8. runs the reconciler, then `gh aw validate` and `gh aw doctor`, and prints a summary report.

| Variable | Used for |
| --- | --- |
| `APP_CLIENT_ID`, `APP_PRIVATE_KEY` | An existing GitHub App. Set both, or neither to register a new one. `--non-interactive` needs both. |
| `COPILOT_GITHUB_TOKEN` | With `--engine copilot`: a fine-grained personal access token. Without it the engine authenticates with the Actions token. A secret value that contains `gho_`, the prefix of an OAuth token, is refused. |
| `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `CODEX_API_KEY`, `GEMINI_API_KEY` | The API key of the `claude`, `codex`, `gemini` or `pi` engine. |
| `GH_TOKEN` or `GITHUB_TOKEN` | Your own credential for writing the repository variables and secrets. Falls back to `gh auth token`. |
| `SDLC_MANIFEST` | The manifest path, relative to the repository root; `--manifest` takes precedence. |
| `SDLC_BOOTSTRAP_NO_OPEN_BROWSER` | Any non-empty value prints URLs instead of opening a browser. |
| `SDLC_GH_AW_DATA_HOME` | A separate gh-aw installation, as above. |

In an interactive run, an engine credential that is not in the environment is asked for at a prompt that does not echo it.

### sdlc-onboard

```text
npx sdlc-onboard --repo <owner/repo-or-path> [--downstream <owner/repo>]
  [--strategy auto|content-and-docs-sync|dependency-and-pattern-modernization|code-quality-and-improvement-scan|custom]
  [--watch-url <url>]... [--schedule <cron>] [--mode auto|mechanical|ai-adaptation]
  [--instructions <text-or-path>] [--manifest sdlc.yaml]
```

Points the orchestrator at one more repository. The repository may also be given as a positional `<owner/repo>`, and `--repo` may be a path to a local clone. The command inspects the repository read-only, then writes the matching `projects[]` and `dependencyEdges[]` entries to `sdlc.yaml` (keeping its comments) and `instructions/<projectKey>.md`, creates the edge's state variable if it is missing, and runs the reconciler and the readiness checks.

- `--downstream` names a repository that receives this one's changes. It has to have the same owner as the orchestrator repository, because one App installation token is scoped to one owner. `--mode` other than `auto` needs it.
- `--watch-url` can be repeated. `--schedule` is a five-field cron expression.
- `--instructions` is text, or the path of a file.

`APP_CLIENT_ID` and `APP_PRIVATE_KEY` have to be set: the command needs the App's slug. Review the result before you commit it.

### sdlc-reconcile

```text
npx sdlc-reconcile --request <file>
```

Renders the workflows from the manifest that the request names, compiles them with `gh aw compile --strict` and rolls every file back if anything fails. The request is a JSON file with nine keys, shown on the [API page](docs/api.md#ai-sdlc-factoryreconcile). The result is printed as JSON. Use it after you change the manifest and after you update the factory.

## Manifest

`sdlc.yaml` lists:

| Key | Declares |
| --- | --- |
| `projects` | The repositories of your fleet and, for each, an optional scheduled upkeep: what to watch, how to verify a change, who reviews it. |
| `dependencyEdges` | Edges from an upstream repository to a downstream repository, `mechanical` or `ai-adaptation`, with the commands to run and the files a change may touch. |
| `factory` | Where the factory package is installed, and whether jobs need a token to install it. |
| `state`, `dedupe`, `prompts`, `onboarding`, `protectedFilesExclude` | How the sync state is spelled, how duplicate pull requests are recognized, wording of the prompts, what onboarding takes for a provenance file, and files that pull requests may change. |

[The manifest reference](docs/manifest.md) documents every key, with an example for each.

## Updating

An update is one pull request. The tag in `package.json` is readable; the lockfile pins the commit.

1. Install the new tag. If the factory repository is private, give npm the same URL rewrite that the workflows use. The token lives only in this shell's environment.

   ```bash
   repo=<owner>/ai-sdlc-factory
   token=$(gh auth token)
   export GIT_CONFIG_COUNT=3
   for i in 0 1 2; do export "GIT_CONFIG_KEY_$i=url.https://x-access-token:$token@github.com/$repo.insteadOf"; done
   export GIT_CONFIG_VALUE_0="ssh://git@github.com/$repo" GIT_CONFIG_VALUE_1="git@github.com:$repo" GIT_CONFIG_VALUE_2="https://github.com/$repo"
   npm install "github:$repo#vX.Y.Z" --ignore-scripts
   unset GIT_CONFIG_COUNT GIT_CONFIG_KEY_{0..2} GIT_CONFIG_VALUE_{0..2}
   ```

   ```powershell
   $repo = '<owner>/ai-sdlc-factory'
   $token = gh auth token
   $env:GIT_CONFIG_COUNT = '3'
   0..2 | ForEach-Object { Set-Item "env:GIT_CONFIG_KEY_$_" "url.https://x-access-token:$token@github.com/$repo.insteadOf" }
   $env:GIT_CONFIG_VALUE_0 = "ssh://git@github.com/$repo"; $env:GIT_CONFIG_VALUE_1 = "git@github.com:$repo"; $env:GIT_CONFIG_VALUE_2 = "https://github.com/$repo"
   npm install "github:$repo#vX.Y.Z" --ignore-scripts
   Remove-Item env:GIT_CONFIG_COUNT, env:GIT_CONFIG_KEY_*, env:GIT_CONFIG_VALUE_*
   ```

   For a public factory repository, `npm install "github:<owner>/ai-sdlc-factory#vX.Y.Z" --ignore-scripts` is enough.

2. Regenerate the workflows with the new renderer, using the same request file as before (it needs gh-aw 1.0.1 or newer):

   ```text
   npx sdlc-reconcile --request <request.json>
   ```

3. Review `git diff --stat`, read the [Breaking and Migration notes](CHANGELOG.md) of every release between the old tag and the new one, run your own tests, and commit `package.json`, `package-lock.json` and `.github/workflows` together.

Do not update `sdlc-onboard.md` with `gh aw update`: it is rendered by the reconciler, which writes the App's slug into it. Update the factory with npm and run `sdlc-reconcile`. Whether Dependabot or Renovate update an npm git dependency has not been checked, so use the steps above.

### The workflows as a gh-aw package

This repository is also a gh-aw package. Its `aw.yml` installs a seed of the onboarding workflow, `.github/workflows/sdlc-onboard.md`, into a repository with `gh aw add`; the seed names no GitHub App. `sdlc-bootstrap` overwrites it with the real one, so installing with npm and running the bootstrap is the supported route. Installing a package from a private repository with `gh aw add` has not been checked.

## Known limitations

- **The onboarding workflow cannot complete on its own.** The generated `sdlc-onboard` workflow tells its agent to run `sdlc-onboard`, but it installs neither the factory nor the gh-aw CLI, passes no App credentials to a step that runs the command, and gives the agent no network access. Run `sdlc-onboard` from your machine.
- **A failing install is silent in two jobs.** If the factory cannot be installed in the `escalate_failure` or `finalize_poll_state` job of a workflow, no failure issue is opened for that failure. The failing job in the Actions run is the signal.

## Development

```bash
npm ci
npm test
node tools/leak-guard/scan.mjs --tree
```

`npm test` runs the suites under `tests/`; it takes a while, so run one file while you work, for example `node --test tests/s5/readme.test.mjs`. Tests that need the real gh-aw run only when `SDLC_REAL_GH_AW=1` is set, and use `SDLC_GH_AW_DATA_HOME` when your global gh-aw is older than 1.0.1.

`examples/` is a synthetic reference preset, built to exercise every feature of the factory: a manifest, its instructions and scripts, and the workflows that the renderer produces for it. Every name, schedule and command in it is invented, and its committed workflows are the golden output that the tests compare the renderer with. After you change anything that alters rendered output, regenerate it and review the diff:

```bash
node tools/update-examples.mjs --compile
git diff -- examples
```

`tools/leak-guard` keeps the repository free of identifiers that must not be published; see [Architecture](docs/architecture.md#the-factory-repositorys-own-safeguards). `node tools/update-payload.mjs` regenerates `payload/workflows/sdlc-onboard.md`, the seed that `aw.yml` installs.

## License

MIT. See [LICENSE](LICENSE).
