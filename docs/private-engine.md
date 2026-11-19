# Installing a private factory

By default the factory is an npm dependency that your workflows install from its GitHub repository. While that repository is private, the workflows need a credential to read it. This page describes what the reconciler renders for that, why, and how it fails. With `factory.private: false` none of it applies.

## Why a credential is needed

Your lockfile records the factory as `git+ssh://git@github.com/<owner>/ai-sdlc-factory.git#<commit>`: the tag in `package.json` is resolved to a commit once, and `npm ci` never looks at the tag again. For a private repository the anonymous HTTPS download that `npm ci` tries first fails, and the SSH fallback fails on a runner that has no SSH key.

`GITHUB_TOKEN` cannot help: its permissions are limited to the repository that holds the workflow. A repository secret holding a personal token would work but is tied to a person. The orchestrator already has a GitHub App, so the install uses a token that the App mints for the one repository.

## What you set up

1. The factory repository exists and your GitHub App is installed on its owner with access to that repository. If the installation is limited to selected repositories, the factory repository has to be one of them. The App needs `Contents` read; the App that `sdlc-bootstrap` registers already holds more.
2. `package.json` of your orchestrator depends on the factory at a release tag, and the lockfile is committed:

   ```json
   "dependencies": { "ai-sdlc-factory": "github:<owner>/ai-sdlc-factory#v0.1.0" }
   ```

3. `sdlc.yaml` says where the factory comes from:

   ```yaml
   factory:
     package: ai-sdlc-factory
     source: github:<owner>/ai-sdlc-factory
     private: true
   ```

`sdlc-bootstrap` adds the factory repository to the repositories that the App has to be installed on, so a missing installation stops the bootstrap and not the first scheduled run.

## What the reconciler renders

Every job that has to install the factory gets two steps: one that mints the token and one that installs with it.

```yaml
- name: Mint the factory read token
  id: factory_token
  uses: actions/create-github-app-token@v2
  with:
    app-id: ${{ vars.APP_CLIENT_ID }}
    private-key: ${{ secrets.APP_PRIVATE_KEY }}
    owner: <owner>
    repositories: ai-sdlc-factory
    permission-contents: read
- name: Install the factory
  env:
    GIT_TERMINAL_PROMPT: "0"
    GIT_CONFIG_COUNT: "3"
    GIT_CONFIG_KEY_0: url.https://x-access-token:${{ steps.factory_token.outputs.token }}@github.com/<owner>/ai-sdlc-factory.insteadOf
    GIT_CONFIG_VALUE_0: ssh://git@github.com/<owner>/ai-sdlc-factory
    GIT_CONFIG_KEY_1: url.https://x-access-token:${{ steps.factory_token.outputs.token }}@github.com/<owner>/ai-sdlc-factory.insteadOf
    GIT_CONFIG_VALUE_1: git@github.com:<owner>/ai-sdlc-factory
    GIT_CONFIG_KEY_2: url.https://x-access-token:${{ steps.factory_token.outputs.token }}@github.com/<owner>/ai-sdlc-factory.insteadOf
    GIT_CONFIG_VALUE_2: https://github.com/<owner>/ai-sdlc-factory
  run: npm ci --ignore-scripts
```

- **The token** is minted for one repository with `contents: read`. gh-aw's strict mode requires `repositories` and `permission-*` on every such step, so a token that could reach the whole installation does not compile. The step is not named `create-token` because gh-aw treats that id specially. The token is masked in logs and revoked when the job ends; the renderer never sets `skip-token-revoke`.
- **The rewrite** uses git's `GIT_CONFIG_COUNT`, `GIT_CONFIG_KEY_n` and `GIT_CONFIG_VALUE_n`, which git adds to its runtime configuration. They give three `url.<base>.insteadOf` rules for the factory repository only: the `ssh://` form that the lockfile carries, the scp-like form, and the `https://` form. Every other GitHub URL that npm touches is left alone, so the token is not offered to it.
- **Nothing is written to disk.** The variables exist only in the environment of that one step. Nothing goes to `~/.gitconfig`, the clone's `origin` stays `ssh://git@github.com/…`, and the installed package has no `.git` directory. Every checkout that the reconciler renders sets `persist-credentials: false`, so no checkout leaves an authorization header for git to send along.
- **Install scripts stay off.** `--ignore-scripts` keeps the lifecycle scripts of the factory's dependencies from running in jobs that hold the App's key. The factory itself has no install-time script.

### Where it is installed

| Job | Gets the install steps |
| --- | --- |
| The router, `cascade-router.yml` | yes |
| The `escalate_failure` job of drift and implementation workflows, and `escalate_failure` and `finalize_poll_state` of cascade workflows | yes |
| Agent jobs of drift workflows, implementation workflows and AI-adaptation cascades | yes, as the first `pre-agent-steps` entry: they run factory scripts on the host, outside the agent's sandbox |
| The agent job of a mechanical cascade | only when a manifest command contains `<factory>` or `<factory-dir>` |
| gh-aw's own jobs (`activation`, `detection`, `safe_outputs`, `conclusion`) | no |

The agent itself calls nothing from the factory. It reads the files that the pre-agent steps wrote. It can see the installed package as it could see any file of the workspace, which is why a validator that the agent must not change is [staged](manifest.md#staged-scripts) as a read-only copy and compared before it runs.

The checkout of the custom jobs of drift, implementation and cascade workflows holds only `package.json`, `package-lock.json` and the manifest, as non-cone patterns: cone mode takes directories only, so listing files there would fail the job. The router checks out the whole repository, because it runs your preflight commands from it.

## When the factory becomes public

`factory.private: false` removes the token step and the environment of the install step, and nothing else: the step is exactly `npm ci --ignore-scripts`. The lockfile does not change. For a public repository npm downloads a tarball over HTTPS and needs no credential.

Do it in this order, because the reverse breaks the running workflows:

1. Make the factory repository public.
2. Check that an unauthenticated install works: run `npm ci --ignore-scripts` against your lockfile on a machine or container with no token and no `GIT_CONFIG_*` variables.
3. Set `factory.private: false`, run `sdlc-reconcile`, review the diff and merge it.
4. Last, remove the factory repository from the App's installation.

## Failure modes

| Failure | What happens | What to do |
| --- | --- | --- |
| The App is not installed on the factory repository | The token step fails with a 404 in the first step of the job, before the agent runs. | `sdlc-bootstrap` checks for this up front. Install the App on the repository and re-run. |
| The factory cannot be installed in `escalate_failure` or `finalize_poll_state` | No failure issue is opened for that failure. This is a known limitation. The red job in the Actions run is the signal. | Watch the Actions tab; check the installation if one of these jobs fails at the install step. |
| The release tag is moved or deleted after you locked it | Nothing: the lockfile pins the commit. | Keep release tags immutable. A tag ruleset can enforce it where your plan offers rulesets. |
| The factory repository is renamed or transferred | The old URL may redirect, but `factory.source`, the token's `repositories` and `package.json` name the old repository. | Change `factory.source` and `package.json` together, run `npm install` and `sdlc-reconcile`, and commit the lockfile and the workflows in one change. |
| The npm registry cannot be reached | `npm ci` fails for the factory's registry dependencies (`ajv`, `yaml` and `libsodium-wrappers`). | Retry; nothing in the factory depends on the registry beyond that. |

## Known limitation: the onboarding workflow

The generated `sdlc-onboard` workflow tells its agent to run `sdlc-onboard`, but the workflow does not yet install the factory or the gh-aw CLI, does not hand the App's credentials to a step that runs the command, and gives the agent no network access. The command therefore cannot complete inside the workflow. Run `sdlc-onboard` from your own machine, as described in the [README](../README.md#sdlc-onboard).
