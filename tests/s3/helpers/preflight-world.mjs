// The world of a preflight test: real git remotes for the upstream and the downstream, the stub executables that the edge's commands call (a stub npm, a stub
// helper CLI and a stub classifier in the workspace), and the router wired to the in-process REST stub whose heads are the real commits.
//
// The edge is declared the way a manifest declares one: its preflightCommands, and its preflightChecks (the scope that a drift of each command asks for, and the
// classifier that judges a report-shaped command). The engine knows no kind of command: the first command of the default edge prints a report that its classifier
// reads, the second is a helper CLI whose own exit code (0 no drift, 1 drift, anything else a failure) is the verdict.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createGitWorld, createStubBin, findBash, hostEnvironment } from "./git-world.mjs";
import { routerWorld } from "./harness.mjs";
import { edge as edgeFixture, fixture, presetEdges, readJson, sha, state } from "./fixtures.mjs";

const comparable = (value) => {
  let text = String(value).replace(/\\/g, "/");
  const drive = /^\/([A-Za-z])\/(.*)$/.exec(text);
  if (drive) text = `${drive[1]}:/${drive[2]}`;
  text = text.replace(/\/+$/, "");
  return process.platform === "win32" ? text.toLowerCase() : text;
};
/** True when two spellings (C:\x, c:/x, /c/x) name the same path. */
export const samePath = (a, b) => comparable(a) === comparable(b);
/** A path as a native program names it: the router gives bash `/c/x` on Windows, which node cannot open. */
export const nativePath = (value) => (process.platform === "win32" ? String(value).replace(/\\/g, "/").replace(/^\/([A-Za-z])\//, (_, drive) => `${drive.toUpperCase()}:/`) : String(value));

export const REPORT_COMMAND = "npm run check:inputs -- <checkout>";
export const HELPER_COMMAND = 'node "$GITHUB_WORKSPACE/scripts/check-drift.mjs" --downstream "$GITHUB_WORKSPACE/hub" --upstream <checkout> --commit "$TARGET_SHA"';
export const CHECK_COMMANDS = [REPORT_COMMAND, HELPER_COMMAND];
export const CLASSIFIER = 'node "$GITHUB_WORKSPACE/scripts/classify.mjs"';
export const DECLARED_CHECKS = [{ scope: "docs-only", classifier: CLASSIFIER }, { scope: "app-only" }];
export const SCOPES = ["both", "docs-only", "app-only"];

/**
 * The files that the workspace of a test needs when a fake (fake-preflight.mjs) stands in for the shell: the scripts that the default edge's commands name. The
 * router refuses a node script that is not in the workspace (src/routing/preflight.mjs), so they have to be there although the fake answers for them. A test that
 * leaves one out says so on purpose.
 */
export const STAND_IN_SCRIPTS = Object.freeze({
  "scripts/check-drift.mjs": "// stands in for the helper: the fake shell answers for it\n",
  "scripts/classify.mjs": "// stands in for the classifier: the fake shell answers for it\n",
});

export const CLEAN_REPORT = "Inputs checked: 25; changed 0, new 0, gone 0\nThe content matches the inputs.\n";
export const CHANGED_REPORT = "Inputs checked: 25; changed 2, new 0, gone 1\n changed: content/page03.md\nThe content was written against different inputs.\n";
export const PROBLEM_REPORT = "Inputs checked: 25; changed 0, new 0, gone 0\n PROBLEM anchor: page07 cites a heading that is gone\n";
export const IN_SYNC = { status: "in-sync", changed: [] };
export const DRIFT = { status: "drift", changed: ["page03", "page07"] };

/**
 * What the stub helper does. An answer of the helper's own shape is printed as it is and the exit code is the helper's contract (1 for drift, 0 otherwise); an
 * object with `code`, `stdout` or `stderr` says exactly what to do, for the helper that misbehaves.
 */
export function helperScript(drift) {
  if (["code", "stdout", "stderr"].some((key) => Object.hasOwn(drift, key))) return drift;
  return { code: drift.status === "drift" ? 1 : 0, stdout: drift };
}

/**
 * @param {object} spec
 * @param {object} spec.edge the router edge (its repositories name the git remotes; its preflightChecks and syncScopes are what the manifest edge declares)
 * @param {Record<string, string>[]} spec.upstreamCommits the file sets of the upstream's commits, in order; the first is the merge cursor, the last the head
 * @param {Record<string, string>} [spec.downstreamFiles] the files of the downstream's head commit
 * @param {(shas: string[]) => object} [spec.stateOverrides]
 * @param {object[]} [spec.npm] rules of the stub npm (default: a clean report for `run check:inputs`, success for `ci`)
 * @param {object | null} [spec.helper] what the stub helper CLI answers (scripts/check-drift.mjs); null leaves the workspace without it
 * @param {object | null} [spec.classifier] what the stub classifier answers (scripts/classify.mjs: { code } or { codes } by check index, { stderr }); null leaves it out
 * @param {object} [spec.rest] fields for the REST stub's upstream repository
 * @param {object} [spec.downstreamRest] fields for the REST stub's downstream repository
 * @param {number} [spec.headIndex] which of the upstream commits the REST side reports as the head (default: the last)
 * @param {string} [spec.workspacePrefix]
 */
export function createPreflightWorld(spec) {
  const git = createGitWorld();
  const unseeded = spec.edge;
  const upstreamShas = spec.upstreamCommits.map((files, index) => git.commit(unseeded.upstreamRepo, files, `upstream ${index}`));
  const upstreamHead = upstreamShas[spec.headIndex ?? upstreamShas.length - 1];
  const downstreamSha = git.commit(unseeded.downstreamRepo, spec.downstreamFiles ?? { "README.md": "the downstream\n" }, "downstream main");
  const bin = createStubBin({
    npm: {
      rules: spec.npm ?? [
        { match: "^ci", code: 0 },
        { match: "^run check:inputs", code: 0, stdout: CLEAN_REPORT },
      ],
    },
  });
  const runnerTemp = fs.mkdtempSync(path.join(os.tmpdir(), "sdlc-s3-runner-temp-"));
  const state0 = state({ lastMergedUpstreamSha: upstreamShas[0], lastObservedHeadSha: upstreamShas[0], portfolioMainSha: downstreamSha, ...(spec.stateOverrides?.(upstreamShas) ?? {}) }, unseeded);
  // A seeded world (AC13, AC14): the bootstrap writes the merge cursor from the baseline of the edge, so the baseline of the edge is the commit that the cursor starts at.
  // The downstream has no provenance file on main unless the world says so, which is the time before the first merged cascade pull request, when the router falls back
  // to that cursor; a world whose cursor was advanced would have to carry the file.
  const edge = { ...unseeded, initialBaselineSha: state0.lastMergedUpstreamSha };
  const worldOptions = spec.worldOptions ?? {};
  const w = routerWorld({
    edge,
    state: state0,
    upstream: { head: upstreamHead, defaultBranch: edge.upstreamDefaultBranch, ...(spec.rest ?? {}) },
    downstream: { head: downstreamSha, ...(spec.downstreamRest ?? {}) },
    workspacePrefix: spec.workspacePrefix,
    env: { ...hostEnvironment(), ...git.environment(), PATH: bin.path(), RUNNER_TEMP: runnerTemp },
    ...worldOptions,
    ...(worldOptions.manifestEdges === undefined
      ? {}
      : { manifestEdges: worldOptions.manifestEdges.map((entry) => (entry.upstreamKey === edge.upstreamKey ? { ...entry, initialBaselineSha: edge.initialBaselineSha } : entry)) }),
  });
  const scriptsDir = path.join(w.workspace.dir, "scripts");
  if (spec.helper !== null && spec.helper !== undefined) {
    fs.mkdirSync(scriptsDir, { recursive: true });
    fs.copyFileSync(fixture("helpers", "check-drift.stub.mjs"), path.join(scriptsDir, "check-drift.mjs"));
    fs.writeFileSync(path.join(scriptsDir, "check-drift.stub.json"), JSON.stringify(helperScript(spec.helper)));
  }
  if (spec.classifier !== null && spec.classifier !== undefined) {
    fs.mkdirSync(scriptsDir, { recursive: true });
    fs.copyFileSync(fixture("helpers", "classify.stub.mjs"), path.join(scriptsDir, "classify.mjs"));
    fs.writeFileSync(path.join(scriptsDir, "classify.stub.json"), JSON.stringify(spec.classifier));
  }
  const bash = findBash();
  const calls = (name) => {
    const file = path.join(scriptsDir, name);
    return fs.existsSync(file) ? fs.readFileSync(file, "utf8").trimEnd().split("\n").filter(Boolean).map((line) => JSON.parse(line)) : [];
  };
  const world = {
    w,
    git,
    bin,
    edge,
    upstreamShas,
    upstreamHead,
    downstreamSha,
    runnerTemp,
    bash,
    upstreamDir: path.join(w.workspace.dir, "upstream", edge.upstreamRepo.split("/")[1]),
    downstreamDir: path.join(w.workspace.dir, edge.downstreamRepo.split("/")[1]),
    go: (extra = {}) => w.go({ bash, ...extra }),
    helperCalls: () => calls("check-drift.log.jsonl"),
    classifierCalls: () => calls("classify.log.jsonl"),
    /** What of the preflight is left in the temp directory of the runner. */
    leftovers: () => fs.readdirSync(runnerTemp),
    cleanup() {
      w.cleanup();
      git.cleanup();
      bin.cleanup();
      fs.rmSync(runnerTemp, { recursive: true, force: true });
    },
  };
  return world;
}

/** A synthetic edge for a preflight test, declared the way a manifest declares it: two commands, their two checks and the scopes that they ask for. */
export const preflightEdge = (overrides = {}) =>
  edgeFixture({
    edgeId: "content",
    upstreamRepo: "initech/content",
    upstreamKey: "content",
    upstreamSlug: "CONTENT",
    upstreamDefaultBranch: "main",
    downstreamRepo: "acme/hub",
    stateVariable: "SDLC_SYNC_STATE_CONTENT",
    provenanceFile: "docs/provenance.json",
    branchName: "sdlc/cascade-content",
    closeOlderKey: "sdlc-cascade-content",
    preflightCommands: CHECK_COMMANDS,
    preflightChecks: DECLARED_CHECKS,
    syncScopes: SCOPES,
    ...overrides,
  });

export const contentFiles = (n) => ({ "content/page01.md": `page 1 revision ${n}\n`, "README.md": `readme ${n}\n` });

/** A runs-listing snapshot world: the preset declares the command and classifier; the engine never captures or rewrites the snapshot. */
export function createSnapshotWorld(spec = {}) {
  const edge = edgeFixture({ ...presetEdges().find((entry) => entry.edgeId === "pipelines-to-hub"), ...spec.edge });
  const options = {
    edge,
    upstreamCommits: [contentFiles(1), contentFiles(2)],
    downstreamFiles: { "README.md": "the downstream\n", "content/pipelines/run-data.json": '{"entries":["fixture"]}\n' },
    classifier: spec.classifier === undefined ? { code: 0 } : spec.classifier,
    ...spec.extra,
  };
  const world = createPreflightWorld(options);
  if (options.classifier !== null) fs.copyFileSync(fixture("helpers", "classify.stub.mjs"), path.join(world.w.workspace.dir, "scripts", "classify-runs.mjs"));
  world.bin.set("gh", [{ match: "^api ", code: 0, stdout: '{"total_count":0,"workflow_runs":[]}\n', ...spec.listing }]);
  return world;
}

// ---- an edge whose only check is a git diff of the tracked paths between the merge cursor and the target -----------------------------------------

export const gitDiffEdge = (overrides = {}) =>
  preflightEdge({
    edgeId: "tracked",
    upstreamRepo: "initech/tracked",
    upstreamKey: "tracked",
    upstreamSlug: "TRACKED",
    stateVariable: "SDLC_SYNC_STATE_TRACKED",
    provenanceFile: "docs/tracked/provenance.json",
    branchName: "sdlc/cascade-tracked",
    closeOlderKey: "sdlc-cascade-tracked",
    preflightCommands: ['git -C <checkout> diff --quiet "$LAST_MERGED_SHA" "$TARGET_SHA" -- content assets src index.html README.md'],
    preflightChecks: [{ scope: "tracked-paths" }],
    syncScopes: ["both", "tracked-paths"],
    buildCommands: ["npm run build"],
    ...overrides,
  });

/** The commits of tests/s3/fixtures/git/history.json by name, in order. */
export const HISTORY_COMMITS = readJson(fixture("git", "history.json")).commits.map((commit) => commit.name);

/**
 * @param {object} [spec]
 * @param {string} [spec.lastMerged] the commit (by name) that the merge cursor is at (default: baseline)
 * @param {string} [spec.target] the commit (by name) that the upstream's head is at
 * @param {object} [spec.edge] overrides of the edge
 * @param {object} [spec.extra] more of createPreflightWorld's fields
 */
export function createGitDiffWorld(spec = {}) {
  const history = readJson(fixture("git", "history.json"));
  const names = history.commits.map((commit) => commit.name);
  const edge = gitDiffEdge(spec.edge ?? {});
  const at = (name) => {
    const index = names.indexOf(name);
    if (index < 0) throw new Error(`no commit named ${name} in the history fixture`);
    return index;
  };
  return createPreflightWorld({
    edge,
    upstreamCommits: history.commits.map((commit) => commit.files),
    headIndex: at(spec.target ?? names.at(-1)),
    stateOverrides: (shas) => ({ lastMergedUpstreamSha: shas[at(spec.lastMerged ?? "baseline")], lastObservedHeadSha: shas[at(spec.lastMerged ?? "baseline")] }),
    ...(spec.extra ?? {}),
  });
}
export { sha };
