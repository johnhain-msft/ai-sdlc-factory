# Public API

This page lists what you may rely on between releases. Everything else in the package is internal and can change in any release.

The package `exports` map is the boundary. A deep import such as `ai-sdlc-factory/src/reconcile.mjs` fails with `ERR_PACKAGE_PATH_NOT_EXPORTED`.

| Export | Use it for |
| --- | --- |
| `ai-sdlc-factory/script-kit` | Scripts that live in your orchestrator repository: classifiers, helpers, anything a manifest command runs. |
| `ai-sdlc-factory/drift-lib` | A script that is [staged](manifest.md#staged-scripts) so that the agent cannot change it. |
| `ai-sdlc-factory/reconcile` | Rendering and reconciling a fleet from code instead of from `sdlc-reconcile`. |
| `ai-sdlc-factory/schemas/*` | The JSON schemas, for editors and validators: `sdlc.schema.json` (the manifest), `sdlc-routing.schema.json`, `bootstrap-summary-report.schema.json`, `drift-compile-ack.schema.json` and `github-pull-request-response.schema.json`. |
| `ai-sdlc-factory/package.json` | Reading the version and finding the package directory. |

The package also installs three commands, [`sdlc-bootstrap`, `sdlc-onboard` and `sdlc-reconcile`](../README.md#commands).

## What is covered by the version number

The project follows semantic versioning. Before 1.0.0 a minor release may break the manifest schema; the CHANGELOG lists each break under *Breaking* and says how to migrate under *Migration*. A patch release only fixes.

These are the public surface:

1. The manifest schema (`schemas/sdlc.schema.json`) and the routing schema.
2. The reconcile request (nine closed keys) and the JSON that `sdlc-bootstrap`, `sdlc-onboard` and `sdlc-reconcile` print, with their flags and exit codes (0 success, 1 failure, 2 a usage error).
3. The run-time contract of the rendered workflows: the flags, environment variables and exit codes of the scripts that committed workflows call (`prepare-run`, `dedupe-open-prs`, `previous-watch-index`, `snapshot-watch-sources`, `read-report`, `escalate-gate-failure`, `route-upstream`, `update-poll-state`, `ai-pull-request-result` and `verify-immutable-gates`), and the shape of the sync-state variable. A workflow that you committed with one release has to run with the next one until you regenerate it.
4. The names exported by the three modules below.

The text of the rendered workflows is **not** public. It can change in any release; regenerate and review the diff.

### Deprecations

| Item | Deprecated in | Removed in |
| --- | --- | --- |
| `--portfolio`, the old name of `--downstream` in `verify-immutable-gates` | 0.1.0 | 0.3.0 |
| Reading `portfolioMainSha`, the `state` block and the state dialect (see [sync state](architecture.md#sync-state)) | 0.1.0 | 1.0.0 |

## ai-sdlc-factory/script-kit

The one surface that the scripts of an orchestrator import. A name is added in a minor release and removed only in a major one.

```js
import { helperSection, parseFlags, readManifest, resolveIo, runAsMain, workspaceOf } from "ai-sdlc-factory/script-kit";

export async function run(argv, ioInput = {}) {
  const io = resolveIo(ioInput);
  const flags = parseFlags(argv, { upstream: { type: "string" }, accept: { type: "boolean" } });
  const { document } = await readManifest({ cwd: workspaceOf(io), env: io.env });
  const settings = helperSection(document, "sourceCheck");
  io.stdout(`${JSON.stringify({ upstream: flags.upstream ?? null, settings })}\n`);
  return settings === null ? 2 : 0;
}

await runAsMain(import.meta.url, run);
```

### Flags and process

| Name | Kind | What it does |
| --- | --- | --- |
| `parseFlags` | function | `parseFlags(argv, spec)` reads `--name value`, `--name=value` and `--flag` against `spec` (`{ name: { type: "string" or "boolean" } }`) and returns only the options that were given. A value option takes the next argument even when it starts with a dash. An unknown option throws `UsageError`. |
| `parseBoolean` | function | `parseBoolean(value, label)` accepts `true` and `false` in any case, and the empty string as `false`; anything else throws `UsageError`. |
| `requireSlug` | function | `requireSlug(value, label)` returns a trimmed `<owner>/<repo>` slug or throws `UsageError`. |
| `repoName` | function | `repoName(slug)` returns the repository part of a slug, which is also the checkout directory that the workflows use. |
| `UsageError` | class | Thrown for a bad flag or value. A script that exits 2 on it follows the convention of the factory's own scripts. |
| `resolveIo` | function | `resolveIo(io)` fills in what a script needs (`env`, `cwd`, `fs`, `fetch`, `now`, `stdout`, `stderr`) so that a test can pass its own. |
| `runAsMain` | function | `runAsMain(import.meta.url, run)` calls `run(argv)` only when the module is the script that node started, and sets the exit code to its result (1 if it throws). |
| `workspaceOf` | function | `workspaceOf(io)` is `GITHUB_WORKSPACE` when set, else the current directory. |
| `outDirectory` | function | `outDirectory(flag, env)` is the artifact directory: the flag, else `SDLC_DRIFT_OUT`, else `/tmp/gh-aw/agent`. |
| `stableJson` | function | `stableJson(value)` is two-space JSON with a final newline, so that an identical value is an identical file. |
| `writeFilesAtomically` | function | `writeFilesAtomically([{ path, data }])` writes several files through temporary files and renames, rolls all of them back when one step fails, and leaves a file whose bytes are unchanged untouched. Returns `{ written, unchanged }`. |
| `BASE_SHA_VARIABLE` | constant | `SDLC_BASE_SHA`: the environment variable that carries the base commit of the target checkout from the first step of a job to the later ones. |

### The manifest

| Name | Kind | What it does |
| --- | --- | --- |
| `readManifest` | function | `await readManifest({ cwd, env, avoid })` finds the manifest (`SDLC_MANIFEST`, else `sdlc.yaml`, in `cwd` and then in `GITHUB_WORKSPACE`) and returns `{ file, document }`. Throws `ManifestError` when it is missing or is not a mapping. |
| `locateManifest` | function | `locateManifest({ cwd, env, avoid })` is the lookup of `readManifest` alone: the absolute path, or `null`. A candidate inside a directory of `avoid` is skipped. |
| `helperSection` | function | `helperSection(document, name)` returns `adaptation.helpers[name]` of the AI edges, or `null` when no edge declares it. Edges that declare it differently throw `ManifestError`. |
| `aiEdges` | function | `aiEdges(document)` lists the `ai-adaptation` edges. |
| `workflowIdOf` | function | `workflowIdOf(edge)` is the workflow id of an edge, as the reconciler names it. |
| `relativePath` | function | `relativePath(value, label)` accepts a repository-relative path (no absolute path, drive letter or `..` segment) and returns it with `/` separators, or throws `ManifestError`. |
| `resolvePointer` | function | `resolvePointer(document, pointer)` follows a JSON pointer (RFC 6901) and returns the value, or `undefined`. |
| `isInside` | function | `isInside(parent, child)` is true when `child` is `parent` or lies beneath it, after resolving links. |
| `ManifestError` | class | A problem with the manifest or with the data that a helper needs from it. |

### Reading TypeScript

| Name | Kind | What it does |
| --- | --- | --- |
| `scan` | function | `scan(source)` tokenizes TypeScript or JavaScript text without a compiler: `{ tokens, comments, lineOf, lineStart, lineEnd }`. |
| `matchingBracket` | function | `matchingBracket(tokens, openIndex)` is the index of the token that closes the bracket opened at `openIndex`, or -1. |
| `inComment` | function | `inComment(comments, offset)` is true when the offset lies inside a comment of the scan. |

### Git and checkouts

| Name | Kind | What it does |
| --- | --- | --- |
| `execute` | function | `await execute(command, args, { cwd, env, input, timeoutMs })` runs a program without a shell and never throws: the result has `code`, `stdout`, `stderr`, `timedOut` and `error`. |
| `git` | function | `await git(args, { cwd, env, timeoutMs, tolerate })` runs git and throws an error that names the command and the tail of its output on a non-zero exit. It is not the same function as `git` of `drift-lib`. |
| `ensureCheckout` | function | `await ensureCheckout({ dir, serverUrl, slug, sha, history, token, environment })` makes `dir` a checkout of `slug` at `sha`, shallow or full, and reuses a clean one that is already there. A read token reaches git only as an authorization header over https. It throws an error that names the directory when `dir` exists and is not a clean checkout of `sha`. |
| `isolatedClone` | function | `await isolatedClone({ source, parent, environment })` makes a fresh local clone of an existing checkout in a temporary directory, so that a command can run against it and change nothing in the original. |
| `childEnvironment` | function | `childEnvironment(source, extra)` is the environment for a child process: the allowlisted variables of `source`, then `extra`. Credentials are not on the allowlist. |
| `toShellPath` | function | `toShellPath(path)` names a path as bash does on the platform: Git for Windows reads `C:\x` as `/c/x`. Elsewhere the path is unchanged. |

### The REST client

| Name | Kind | What it does |
| --- | --- | --- |
| `createRestClient` | function | `createRestClient({ baseUrl, token, fetch, sleep, now, log, deadlineMs, ... })` makes a serial GitHub REST client with `request`, `requestJson` and `paginate`. It waits out rate limits within a deadline, retries a `GET` or `PATCH` twice after a network error or a 502, 503 or 504, never retries a `POST`, never follows a redirect, and never logs a token. |
| `RestError` | class | A failed request, with `kind` (`rate-limit`, `budget`, `permission`, `http` or `network`), `status`, `method`, `path` and the `X-Accepted-GitHub-Permissions` header. |
| `assertInstallationToken` | function | `assertInstallationToken(token, label)` refuses every credential that is not a GitHub App installation token, so that a token that acts as a person never authenticates a request. The message names the kind and never the token. |
| `resolveApiBase` | function | `resolveApiBase(env)` is `GITHUB_API_URL`, else `https://api.github.com`; plain http is accepted for a loopback address only. |
| `repoPath` | function | `repoPath(slug)` is `/repos/<owner>/<repo>` with each part encoded. |
| `encodePath` | function | `encodePath(value)` encodes each segment of a path and keeps the slashes. |

## ai-sdlc-factory/drift-lib

The modules of `src/drift/lib` that are safe to stage. They import nothing but `node:` modules and each other, so a copy of the directory runs on its own. A validator that the agent must not be able to change imports the factory only through this module.

| Name | Kind | What it does |
| --- | --- | --- |
| `UsageError` | class | As in `script-kit`. |
| `parseFlags` | function | As in `script-kit`. |
| `parseBoolean` | function | As in `script-kit`. |
| `requireSlug` | function | As in `script-kit`. |
| `repoName` | function | As in `script-kit`. |
| `REPO_SLUG` | constant | The regular expression of an `<owner>/<repo>` slug. |
| `BASE_SHA_VARIABLE` | constant | As in `script-kit`. |
| `DEFAULT_OUT` | constant | `/tmp/gh-aw/agent`, the directory that gh-aw uploads. |
| `VALIDATOR_STAGE_DIRECTORY` | constant | `sdlc-validator`: the directory, under `${RUNNER_TEMP}/gh-aw`, that holds the staged copy. |
| `isMain` | function | `isMain(import.meta.url)` is true when the module is the script that node started. |
| `outDirectory` | function | As in `script-kit`. |
| `resolveIo` | function | As in `script-kit`. |
| `runAsMain` | function | As in `script-kit`. |
| `stableJson` | function | As in `script-kit`. |
| `workspaceOf` | function | As in `script-kit`. |
| `writeFilesAtomically` | function | As in `script-kit`. |
| `CORRELATION_ID` | constant | The pattern of a correlation id: 1 to 128 characters of letters, digits and `._:/+=-`, starting with a letter or a digit. |
| `runCorrelationId` | function | `runCorrelationId(env, runUrl)` derives `run-<run id>-<run attempt>` from the Actions run, or `null`. |
| `loadYaml` | function | `await loadYaml(text, { parser })` parses YAML with the `yaml` package when it is installed and with a built-in subset parser otherwise. |
| `git` | function | `git(args, { cwd, env, input })` runs git synchronously with options that start no fsmonitor, no hook and no replace object. It is not the same function as `git` of `script-kit`. |
| `gitMessage` | function | `gitMessage(error)` is the first line of what git said. |
| `GIT_OPTIONS` | constant | The options that every git call here carries before its own arguments. |
| `COMMIT_LIMIT` | constant | More commits than this ahead of the base commit are refused. |
| `FILE_LIMIT_BYTES` | constant | A patch or bundle larger than this is refused. |
| `TRANSPORT_FILE` | constant | The pattern of the `aw-*.patch` and `aw-*.bundle` files that the agent job uploads. |
| `listRefs` | function | Every ref of a repository, as `{ type, name, peeled, refname }`. |
| `refsByCommit` | function | The refs that point at each commit; an annotated tag counts for the commit that it names. |
| `branchTips` | function | The local branches and the commit that each points at. |
| `replaceRefs` | function | The names of the replace refs. |
| `commitsAhead` | function | The commits that are reachable from the given tips (or any ref) but not from the base commit. |
| `transportFiles` | function | The `aw-*.patch` and `aw-*.bundle` entries of a directory, in name order. |
| `snapshotTransportFiles` | function | Copies those files, so that what is inspected is what the directory held when it looked. |
| `repositoryDirectories` | function | The git directory and the common directory of a checkout, found as files and without a git process. |
| `openScratch` | function | Opens a scratch repository that reads a checkout's objects and index as data, under its own configuration. |
| `workTreePaths` | function | The paths in which the work tree differs from the base commit. |
| `indexPaths` | function | The paths in which the index differs from the base commit. |
| `indexFileText` | function | The text of a file as the index holds it, or `null`. |
| `patchTrees` | function | The trees that the diffs of a patch file would produce, without applying them to the checkout. |
| `bundleCommits` | function | The commits that a bundle file carries beyond the base commit, unbundled into the scratch repository. |

## ai-sdlc-factory/reconcile

The renderer and the reconciler that the `sdlc-reconcile` and `sdlc-bootstrap` commands use. All four take the nine-key request below.

```json
{
  "manifestPath": "sdlc.yaml",
  "appSlug": "example-orchestrator",
  "appClientIdVar": "APP_CLIENT_ID",
  "appPrivateKeySecret": "APP_PRIVATE_KEY",
  "pollStateVarPrefix": "SDLC_SYNC_STATE_",
  "engineAuthMode": "copilot-requests",
  "ghAwVersionPin": ">=v1.0.1",
  "securityBaseline": {
    "minGhAwVersion": "1.0.1",
    "grantedAppPermissions": {
      "contents": "write",
      "pull_requests": "write",
      "issues": "write",
      "actions": "write",
      "variables": "write",
      "metadata": "read"
    },
    "requireStrictMode": true,
    "requireThreatDetection": true,
    "forbidAutoMerge": true
  },
  "dryRun": false
}
```

`engineAuthMode` is `copilot-requests`, `copilot-pat` or `api-key`. A request with a key that is not listed, or without one that is, is refused. `dryRun: true` validates and renders in a scratch copy and writes nothing.

| Name | Kind | What it does |
| --- | --- | --- |
| `renderFleet` | function | `renderFleet(request, { cwd })` renders the workflows without writing a file. It returns `{ ok: true, files, workflows }`, where `files` is a `Map` of repository-relative path to text, or `{ ok: false, result }` with the refusal. |
| `reconcile` | function | `await reconcile(request, { cwd, env, timeoutMs, log })` validates the manifest against the request's security baseline, renders the fleet, compiles it with `gh aw compile --strict --purge` and rolls every file back when anything fails. It never throws: the answer is a `ReconcileResult`, `{ status, generatedWorkflows, repoConfigPath, validationResults }`. |
| `checkRendered` | function | `checkRendered(files, request, manifest)` checks rendered files against the security baseline and the rendering policy: strict mode, threat detection, App permissions within what the App was granted, no auto-merge, a blocked protected-files policy, and no write to the state variables. It returns `[{ file, valid, errors }]`. |
| `buildAcks` | function | `buildAcks(request, { cwd })` renders without writing and returns the acknowledgements of the run: the drift workflows (ids, lock paths, target repositories, allowed network domains, gate commands), the cascade workflows and the AI workflows (allowed files, immutable paths, verification gate). It throws when the manifest is refused. |
