// The edge-declared preflights (SPEC-03 AC20-AC23, AC28, AC40), run for real: git remotes on disk, a bash, the stub npm and a stub helper in the workspace
// of the router. Every case asserts the command that the shell ran (its arguments, its working directory, the variables that were bound, the absence of
// --accept), what was classified, what was persisted and which operations were refused afterwards.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { presetManifest } from "../helpers/preset.mjs";
import {
  CHANGED_REPORT,
  CLEAN_REPORT,
  contentFiles,
  createGitDiffWorld,
  createPreflightWorld,
  DRIFT,
  IN_SYNC,
  nativePath,
  preflightEdge,
  samePath,
} from "./helpers/preflight-world.mjs";
import { edge as edgeFixture, fixture, presetEdges, TOKENS } from "./helpers/fixtures.mjs";

const contentWorld = (overrides = {}) =>
  createPreflightWorld({
    edge: preflightEdge(overrides.edge ?? {}),
    upstreamCommits: [contentFiles(1), contentFiles(2)],
    helper: IN_SYNC,
    classifier: { code: 0 },
    ...overrides.spec,
  });

const npmRun = (world) => world.bin.calls("npm").filter((call) => call.args[0] === "run");

// ---- AC20: the command, its environment and its classification -------------------------------------------------------------------------

test("AC20 preflight runs the declared commands without --accept: the inputs check with the absolute upstream checkout, then the helper, from the downstream checkout", async (t) => {
  const world = contentWorld();
  t.after(() => world.cleanup());
  const result = await world.go();
  assert.equal(result.code, 0, `${result.stderr}\n${result.stdout}`);
  const [run] = npmRun(world);
  assert.deepEqual(run.args.slice(0, 3), ["run", "check:inputs", "--"]);
  assert.equal(run.args.length, 4);
  assert.ok(path.isAbsolute(run.args[3].replace(/^\/([A-Za-z])\//, "$1:/")) || path.isAbsolute(run.args[3]), `UPSTREAM_DIR is absolute: ${run.args[3]}`);
  assert.ok(samePath(run.args[3], world.upstreamDir), `${run.args[3]} is ${world.upstreamDir}`);
  assert.ok(samePath(run.cwd, world.downstreamDir), "the working directory is the downstream checkout");
  const [drift] = world.helperCalls();
  assert.deepEqual(drift.args.slice(0, 1), ["--downstream"]);
  assert.ok(samePath(drift.args[1], world.downstreamDir));
  assert.equal(drift.args[2], "--upstream");
  assert.ok(samePath(drift.args[3], world.upstreamDir));
  assert.deepEqual(drift.args.slice(4), ["--commit", world.upstreamShas[1]]);
  assert.equal([...run.args, ...drift.args].some((argument) => /--accept/.test(argument)), false, "no --accept");
  assert.ok(samePath(drift.cwd, world.downstreamDir));
});

test("AC20 UPSTREAM_DIR, TARGET_SHA and LAST_MERGED_SHA are bound for the command, and the upstream checkout is at the target", async (t) => {
  const world = contentWorld();
  t.after(() => world.cleanup());
  await world.go();
  const [run] = npmRun(world);
  assert.ok(samePath(run.bound.UPSTREAM_DIR, world.upstreamDir));
  assert.equal(run.bound.TARGET_SHA, world.upstreamShas[1]);
  assert.equal(run.bound.LAST_MERGED_SHA, world.upstreamShas[0]);
  assert.ok(samePath(run.bound.GITHUB_WORKSPACE, world.w.workspace.dir));
  assert.equal(world.git.git(world.upstreamDir, ["rev-parse", "HEAD"]).trim(), world.upstreamShas[1], "the upstream checkout is at TARGET_SHA");
  assert.equal(world.git.git(world.downstreamDir, ["rev-parse", "HEAD"]).trim(), world.downstreamSha, "the downstream checkout is at the head that was read");
});

test("AC20 a command that is run by the router never sees the App's key, the write token or the token of the job; it sees one read-only token", async (t) => {
  const world = contentWorld();
  t.after(() => world.cleanup());
  await world.go();
  const [run] = npmRun(world);
  for (const name of ["APP_PRIVATE_KEY", "APP_CLIENT_ID", "ISSUES_TOKEN", "EDGE_JSON", "CLIENT_PAYLOAD", "GITHUB_STEP_SUMMARY"]) assert.equal(run.envNames.includes(name), false, `${name} is not in the environment of a preflight command`);
  const read = world.w.stub.world.minted.filter((entry) => !entry.permissions.variables);
  assert.ok(read.some((entry) => entry.token === run.bound.GH_TOKEN), "GH_TOKEN is a read token of the App");
  assert.notEqual(run.bound.GH_TOKEN, TOKENS.issues);
  const write = world.w.stub.world.minted.find((entry) => entry.permissions.variables === "write");
  assert.notEqual(run.bound.GH_TOKEN, write.token, "not the write token");
  assert.deepEqual(read[0].permissions, { contents: "read", pull_requests: "read", actions: "read" });
});

test("AC20 the downstream's own dependencies are installed before an npm preflight runs, without lifecycle scripts, and never when no preflight needs them", async (t) => {
  const world = contentWorld();
  t.after(() => world.cleanup());
  await world.go();
  const calls = world.bin.calls("npm").map((call) => call.args.join(" "));
  assert.deepEqual(calls, ["ci --include=dev --ignore-scripts", `run check:inputs -- ${world.bin.calls("npm")[1].args[3]}`]);
  assert.ok(samePath(world.bin.calls("npm")[0].cwd, world.downstreamDir));
});

test("AC20 a report command's exit 1 is no drift when its declared classifier says 0", async (t) => {
  const world = contentWorld({ spec: { npm: [{ match: "^ci", code: 0 }, { match: "^run check:inputs", code: 1, stdout: CLEAN_REPORT }] } });
  t.after(() => world.cleanup());
  const result = await world.go();
  assert.equal(result.code, 0, result.stderr);
  assert.equal(world.w.decisions()[0].action, "noop-no-material-drift");
  assert.equal(world.w.stub.world.dispatches.length, 0);
  assert.equal(world.classifierCalls()[0].exitCode, "1");
  assert.equal(world.classifierCalls()[0].stdout, CLEAN_REPORT);
});

test("AC20 a report that names changed inputs is drift although the exit status is the one of a run that found nothing (every other report is classified in preflight-classification.test.mjs)", async (t) => {
  const world = contentWorld({ spec: { npm: [{ match: "^ci", code: 0 }, { match: "^run check:inputs", code: 1, stdout: CHANGED_REPORT }], classifier: { code: 1 } } });
  t.after(() => world.cleanup());
  const result = await world.go();
  assert.equal(result.code, 0, result.stderr);
  assert.equal(world.w.decisions()[0].action, "dispatch-ai-adaptation");
  assert.equal(world.w.stub.world.dispatches[0].body.inputs.sync_scope, "docs-only", "the helper found nothing; only the report's classifier asked for an adaptation");
  assert.equal(world.w.state().inFlightTargetSha, world.upstreamShas[1]);
});

test("AC20 the preflight fails without advancing state when the classifier refuses a report or the dependencies cannot be installed", async (t) => {
  const cases = [
    ["the classifier cannot judge the report", [{ match: "^ci", code: 0 }, { match: "^run check:inputs", code: 1, stdout: "no usable report\n" }], { code: 2, stderr: "no usable report\n" }],
    ["the classifier refuses an unavailable command", [{ match: "^ci", code: 0 }, { match: "^run check:inputs", code: 127, stdout: CLEAN_REPORT }], { code: 2, stderr: "the check could not run\n" }],
    ["npm ci fails", [{ match: "^ci", code: 1, stderr: "ERESOLVE" }, { match: "^run check:inputs", code: 0, stdout: CLEAN_REPORT }], { code: 0 }],
  ];
  for (const [label, npm, classifier] of cases) {
    const world = contentWorld({ spec: { npm, classifier } });
    t.after(() => world.cleanup());
    const before = world.w.stub.variables.get(world.edge.stateVariable);
    const result = await world.go();
    assert.equal(result.code, 1, `${label}: ${result.stdout}`);
    assert.equal(world.w.patches().length, 0, label);
    assert.equal(world.w.stub.world.dispatches.length, 0, label);
    assert.equal(world.w.stub.variables.get(world.edge.stateVariable), before, label);
    assert.equal(world.w.stub.issues.length, 1, label);
    assert.deepEqual(world.w.summaryLines(), [], label);
  }
});

test("AC20 the commands run in a workspace whose path holds a space", async (t) => {
  const world = contentWorld({ spec: { workspacePrefix: "sdlc s3 spaced " } });
  t.after(() => world.cleanup());
  const result = await world.go();
  assert.equal(result.code, 0, `${result.stderr}\n${result.stdout}`);
  assert.ok(world.w.workspace.dir.includes(" "));
  assert.equal(world.helperCalls().length, 1);
});

// ---- AC21: the noop and the bump ---------------------------------------------------------------------------------------------------------

test("AC21 a clean report and helper persist the noop cursors, leave the merge cursor alone and dispatch nothing", async (t) => {
  const world = contentWorld();
  t.after(() => world.cleanup());
  const before = world.w.state();
  const result = await world.go();
  assert.equal(result.code, 0, result.stderr);
  const [target] = [world.upstreamShas[1]];
  assert.deepEqual(world.w.decisions()[0], {
    correlationId: "run-5001-1",
    upstreamRepo: world.edge.upstreamRepo,
    previousSha: world.upstreamShas[0],
    targetSha: target,
    action: "noop-no-material-drift",
    dispatchedWorkflowId: null,
  });
  assert.equal(world.w.patches().length, 1);
  const patched = JSON.parse(JSON.parse(world.w.patches()[0].body).value);
  assert.equal(patched.lastNoopHeadSha, target);
  assert.equal(patched.lastObservedHeadSha, target);
  assert.equal(patched.etag, 'W/"upstream-etag-1"');
  assert.equal(patched.portfolioMainSha, world.downstreamSha);
  assert.equal(patched.lastMergedUpstreamSha, before.lastMergedUpstreamSha, "lastMergedUpstreamSha is untouched");
  assert.equal(patched.lastMergedUpstreamSha, world.upstreamShas[0]);
  assert.equal(world.w.stub.world.dispatches.length, 0);
  assert.deepEqual(world.w.clock.waits, [], "nothing was dispatched, so there is no pacing wait");
});

test("AC21 a second run after a noop is noop-304 and writes nothing", async (t) => {
  const world = contentWorld();
  t.after(() => world.cleanup());
  await world.go();
  assert.equal(world.w.patches().length, 1, "the first run persisted the noop");
  const persisted = world.w.stub.variables.get(world.edge.stateVariable);
  world.w.stub.requests.length = 0;
  const again = await world.go();
  assert.equal(again.code, 0, again.stderr);
  assert.equal(world.w.decisions().at(-1).action, "noop-304");
  assert.equal(world.w.patches().length, 0, "the second run sent no PATCH");
  assert.equal(world.w.stub.variables.get(world.edge.stateVariable), persisted, "and the variable is byte for byte what the first run wrote");
  assert.equal(world.bin.calls("npm").length, 2, "the preflight is not run again for a head that was already found to change nothing");
});

test("AC21 a clean report with onCommitOnlyAdvance bump-provenance is not a noop and is dispatched with the input populated", async (t) => {
  const world = contentWorld({ edge: { onCommitOnlyAdvance: "bump-provenance" } });
  t.after(() => world.cleanup());
  const result = await world.go();
  assert.equal(result.code, 0, result.stderr);
  const decision = world.w.decisions()[0];
  assert.equal(decision.action, "dispatch-ai-adaptation");
  assert.notEqual(decision.action, "noop-no-material-drift");
  const inputs = world.w.stub.world.dispatches[0].body.inputs;
  assert.equal(inputs.on_commit_only_advance, "bump-provenance");
  assert.equal(inputs.sync_scope, "both");
  assert.equal(world.w.state().lastNoopHeadSha, null, "nothing was recorded as a noop");
});

test("AC21 a real helper process that exits 1 dispatches with its declared app-only scope, and the dispatch is what is recorded", async (t) => {
  const world = contentWorld({ spec: { helper: { code: 1, stdout: DRIFT } } });
  t.after(() => world.cleanup());
  const result = await world.go();
  assert.equal(result.code, 0, result.stderr);
  assert.equal(world.w.decisions()[0].action, "dispatch-ai-adaptation");
  const inputs = world.w.stub.world.dispatches[0].body.inputs;
  assert.equal(inputs.sync_scope, "app-only");
  assert.equal(inputs.on_commit_only_advance, "noop");
  assert.equal(world.w.state().lastNoopHeadSha, null, "a dispatch is never recorded as a noop");
  assert.equal(world.w.state().lastMergedUpstreamSha, world.upstreamShas[0], "and it does not advance the merge cursor");
});

// ---- AC40: the helper, as a consumer ---------------------------------------------------------------------------------------------------

test("AC40 exit 2 of the helper is a preflight failure with its message, and other outcomes are classified in preflight-classification.test.mjs", async (t) => {
  const fatal = contentWorld({ spec: { helper: { code: 2, stdout: "", stderr: "fatal: cannot read sources.json\n" } } });
  t.after(() => fatal.cleanup());
  const result = await fatal.go();
  assert.equal(result.code, 1);
  assert.match(result.stderr, /check-drift\.mjs.* exited with 2: fatal: cannot read sources\.json/);
  assert.equal(fatal.w.patches().length, 0);
  assert.equal(fatal.w.stub.world.dispatches.length, 0);
});

test("AC28 preflight-rc-2: a helper that exits 2 fails without advancing etag, merge cursor, noop cursor or pull-request pointers, and upserts one issue", async (t) => {
  const world = contentWorld({ spec: { helper: { code: 2, stdout: "", stderr: "boom\n" } } });
  t.after(() => world.cleanup());
  const before = world.w.state();
  const result = await world.go();
  assert.equal(result.code, 1);
  assert.equal(world.w.patches().length, 0, "zero PATCH requests");
  assert.deepEqual(world.w.state(), before);
  assert.equal(world.w.stub.issues.length, 1);
  assert.equal(world.w.stub.issues[0].title, `[sdlc-failure] cascade-router (${world.edge.upstreamRepo})`);
  for (const cursor of ["etag", "lastMergedUpstreamSha", "lastNoopHeadSha", "openPrTargetSha"]) assert.equal(world.w.state()[cursor], before[cursor], cursor);
});

test("AC40 a helper without a classifier is judged by exit code, never by its output shape or status text", async (t) => {
  const cases = [
    ["not JSON", { code: 0, stdout: "all good\n" }, "noop-no-material-drift"],
    ["exit 1 with status in-sync", { code: 1, stdout: IN_SYNC }, "dispatch-ai-adaptation"],
  ];
  for (const [label, helper, action] of cases) {
    const world = contentWorld({ spec: { helper } });
    t.after(() => world.cleanup());
    const result = await world.go();
    assert.equal(result.code, 0, `${label}: ${result.stderr}`);
    assert.equal(world.w.decisions()[0].action, action, label);
    assert.equal(world.w.patches().length, 1, label);
    assert.equal(world.w.stub.world.dispatches.length, helper.code, label);
    assert.equal(world.w.state().lastNoopHeadSha, helper.code === 0 ? world.upstreamHead : null, label);
    assert.equal(world.w.state().inFlightTargetSha, helper.code === 1 ? world.upstreamHead : null, label);
  }
});

test("AC40 a missing helper is a failure, not a drift and not a clean result: node exits 1 for a file that is not there", async (t) => {
  const world = contentWorld({ spec: { helper: null } });
  t.after(() => world.cleanup());
  assert.equal(fs.existsSync(path.join(world.w.workspace.dir, "scripts", "check-drift.mjs")), false);
  const result = await world.go();
  assert.equal(result.code, 1);
  assert.equal(world.w.patches().length, 0);
  assert.equal(world.w.stub.world.dispatches.length, 0);
  assert.match(result.stderr, /runs scripts\/check-drift\.mjs, which does not exist in the workspace/);
});

test("AC20 the preflight is not run, and nothing is checked out, when the target needs no preflight: the merge cursor and the blocked target decide first", async (t) => {
  const world = contentWorld({ spec: { stateOverrides: (shas) => ({ dismissedTargetSha: shas[1] }) } });
  t.after(() => world.cleanup());
  await world.go();
  assert.equal(world.w.decisions()[0].action, "noop-dismissed-pr");
  assert.equal(world.bin.calls("npm").length, 0);
  assert.equal(fs.existsSync(world.upstreamDir), false);
  assert.equal(fs.existsSync(world.downstreamDir), false);
});

test("a checkout directory that already holds somebody's files is never overwritten: a dirty downstream checkout fails the job and its files are as they were", async (t) => {
  const world = contentWorld();
  t.after(() => world.cleanup());
  fs.mkdirSync(world.downstreamDir, { recursive: true });
  world.git.git(world.downstreamDir, ["init", "--quiet"]);
  fs.writeFileSync(path.join(world.downstreamDir, "mine.txt"), "uncommitted work of somebody else\n");
  const result = await world.go();
  assert.equal(result.code, 1);
  assert.match(result.stderr, /already exists and is not a clean checkout/);
  assert.equal(fs.readFileSync(path.join(world.downstreamDir, "mine.txt"), "utf8"), "uncommitted work of somebody else\n");
  assert.equal(world.w.patches().length, 0);
  assert.equal(world.bin.calls("npm").length, 0, "nothing ran in the foreign tree");
});

test("a clean checkout that is already at the wanted commit is used as it is", async (t) => {
  const world = contentWorld();
  t.after(() => world.cleanup());
  world.git.git(path.dirname(world.downstreamDir), ["clone", "--quiet", world.git.remote(world.edge.downstreamRepo).bare, world.downstreamDir]);
  const result = await world.go();
  assert.equal(result.code, 0, `${result.stderr}\n${result.stdout}`);
  assert.equal(world.w.decisions()[0].action, "noop-no-material-drift");
  assert.equal(world.git.git(world.downstreamDir, ["status", "--porcelain"]).trim(), "", "and it is still clean");
});

// ---- AC22: a declared runs listing and its classifier ---------------------------------------------------------------------------------

const RUNS_LISTING = `${JSON.stringify({ total_count: 1, workflow_runs: [{ id: 101, workflow_id: 201, status: "completed" }] })}\n`;
const SNAPSHOT_FILE = "content/pipelines/run-data.json";
const COMMITTED_SNAPSHOT = '{"entries":["fixture"]}\n';
const patchedState = (world) => JSON.parse(JSON.parse(world.w.patches().at(-1).body).value);
const porcelain = (world) => world.git.git(world.downstreamDir, ["status", "--porcelain"]).trim();

/** The preset's runs edge, with a stub gh and stub classifier as real processes. The engine is not responsible for comparing or capturing snapshots. */
function runsWorld({ classifier = { code: 0 }, listing = { code: 0, stdout: RUNS_LISTING } } = {}) {
  const edge = edgeFixture(presetEdges().find((entry) => entry.edgeId === "pipelines-to-hub"));
  const world = createPreflightWorld({
    edge,
    upstreamCommits: [contentFiles(1), contentFiles(2)],
    downstreamFiles: { "README.md": "the downstream\n", [SNAPSHOT_FILE]: COMMITTED_SNAPSHOT },
    classifier,
    worldOptions: { manifestExtra: { state: presetManifest().state } },
  });
  if (classifier !== null) fs.copyFileSync(fixture("helpers", "classify.stub.mjs"), path.join(world.w.workspace.dir, "scripts", "classify-runs.mjs"));
  world.bin.set("gh", [{ match: "^api ", ...listing }]);
  return world;
}

test("AC22 the preset runs edge records its declared unchanged-snapshot noop and passes the opaque listing to its classifier", async (t) => {
  const world = runsWorld();
  t.after(() => world.cleanup());
  const result = await world.go();
  assert.equal(result.code, 0, `${result.stderr}\n${result.stdout}`);
  const target = world.upstreamHead;
  assert.deepEqual(world.w.decisions()[0], {
    correlationId: "run-5001-1",
    upstreamRepo: world.edge.upstreamRepo,
    previousSha: world.upstreamShas[0],
    targetSha: target,
    action: "noop-unchanged-snapshot",
    dispatchedWorkflowId: null,
  });
  assert.equal(world.w.patches().length, 1);
  const after = patchedState(world);
  assert.equal(after.lastNoopHeadSha, target);
  assert.equal(after.lastObservedHeadSha, target);
  assert.equal(after.etag, 'W/"upstream-etag-1"');
  assert.equal(after.downstreamMainSha, world.downstreamSha);
  assert.equal(Object.hasOwn(after, "portfolioMainSha"), false, "the preset writes the downstream dialect");
  assert.equal(after.lastMergedUpstreamSha, world.upstreamShas[0], "the noop does not advance the merge cursor");
  assert.equal(world.w.stub.world.dispatches.length, 0);
  const [call] = world.bin.calls("gh");
  assert.deepEqual(call.args, ["api", `repos/${world.edge.upstreamRepo}/actions/runs?per_page=100`]);
  assert.ok(samePath(call.cwd, world.downstreamDir));
  assert.equal(world.bin.calls("gh").length, 1);
  assert.equal(world.bin.calls("npm").length, 0, "a gh check needs no dependency install");
  assert.equal(world.classifierCalls().length, 1);
  assert.equal(world.classifierCalls()[0].stdout, RUNS_LISTING);
  assert.equal(world.classifierCalls()[0].command, world.edge.preflightCommands[0]);
  assert.equal(world.classifierCalls()[0].exitCode, "0");
  assert.deepEqual(world.classifierCalls()[0].secrets, []);
  const readToken = world.w.stub.world.minted.find((entry) => entry.permissions.actions === "read" && !entry.permissions.variables);
  const writeToken = world.w.stub.world.minted.find((entry) => entry.permissions.variables === "write");
  assert.equal(call.bound.GH_TOKEN, readToken.token);
  assert.notEqual(call.bound.GH_TOKEN, writeToken.token);
  assert.notEqual(call.bound.GH_TOKEN, TOKENS.issues);
  for (const secret of ["APP_PRIVATE_KEY", "APP_CLIENT_ID", "ISSUES_TOKEN"]) assert.equal(call.envNames.includes(secret), false);
  assert.equal(world.w.stub.fetch.state.maxInflight, 1, "REST reads remain serial");
  assert.deepEqual(world.w.stub.calls().filter((request) => request.method !== "GET" && !request.path.startsWith("/app/")).map((request) => `${request.method} ${request.path}`), [`PATCH /repos/acme/orchestrator/actions/variables/${world.edge.stateVariable}`]);
});

test("AC22 a runs classifier that reports drift dispatches the preset edge's declared scope and records the in-flight pair", async (t) => {
  const world = runsWorld({ classifier: { code: 1 } });
  t.after(() => world.cleanup());
  const result = await world.go();
  assert.equal(result.code, 0, `${result.stderr}\n${result.stdout}`);
  assert.equal(world.w.decisions()[0].action, "dispatch-ai-adaptation");
  const [dispatch] = world.w.stub.world.dispatches;
  assert.equal(dispatch.body.inputs.sync_scope, "runs-only");
  assert.equal(dispatch.body.inputs.upstream_sha, world.upstreamHead);
  assert.equal(world.w.state().inFlightRunId, dispatch.runId);
  assert.equal(world.w.state().inFlightTargetSha, world.upstreamHead);
  assert.equal(world.w.state().lastNoopHeadSha, null);
  assert.deepEqual(world.w.stub.calls("GET", "/actions/runs"), [], "the engine invents no run-listing API reads beyond the edge's command");
});

test("AC22 every classifier verdict leaves the downstream snapshot committed and removes its temporary streams", async (t) => {
  for (const [code, action] of [[0, "noop-unchanged-snapshot"], [1, "dispatch-ai-adaptation"], [2, null]]) {
    const world = runsWorld({ classifier: { code, stderr: code === 2 ? "the listing cannot be judged\n" : "" } });
    t.after(() => world.cleanup());
    const result = await world.go();
    assert.equal(result.code, code === 2 ? 1 : 0, result.stderr);
    assert.equal(world.w.decisions()[0]?.action ?? null, action);
    assert.equal(porcelain(world), "");
    assert.equal(fs.readFileSync(path.join(world.downstreamDir, SNAPSHOT_FILE), "utf8"), COMMITTED_SNAPSHOT);
    assert.equal(world.git.git(world.downstreamDir, ["rev-parse", "HEAD"]).trim(), world.downstreamSha);
    const [call] = world.classifierCalls();
    assert.ok(call);
    for (const file of [call.stdoutFile, call.stderrFile]) {
      assert.ok(samePath(path.dirname(path.dirname(nativePath(file))), world.runnerTemp), "the streams were confined to RUNNER_TEMP");
      assert.equal(fs.existsSync(nativePath(file)), false, "the classifier's streams are removed");
    }
    assert.deepEqual(world.leftovers(), []);
    if (code === 2) {
      assert.equal(world.w.patches().length, 0);
      assert.equal(world.w.stub.world.dispatches.length, 0);
      assert.equal(world.w.stub.issues.length, 1);
    }
  }
});

test("AC22 a failed runs listing reaches its classifier, whose refusal fails without any state advancement or dispatch", async (t) => {
  for (const status of [403, 500]) {
    const message = `gh: HTTP ${status}\n`;
    const world = runsWorld({ listing: { code: 1, stdout: "", stderr: message }, classifier: { code: 2, stderr: "runs listing not available\n" } });
    t.after(() => world.cleanup());
    const before = world.w.stub.variables.get(world.edge.stateVariable);
    const result = await world.go();
    assert.equal(result.code, 1);
    assert.match(result.stderr, /classify-runs\.mjs.* exited with 2: runs listing not available/);
    assert.equal(world.classifierCalls()[0].exitCode, "1");
    assert.equal(world.classifierCalls()[0].stderr, message);
    assert.equal(world.w.stub.variables.get(world.edge.stateVariable), before);
    assert.equal(world.w.patches().length, 0);
    assert.equal(world.w.stub.world.dispatches.length, 0);
    assert.equal(world.w.stub.issues.length, 1);
    assert.deepEqual(world.leftovers(), []);
  }
});

test("AC22 a missing declared runs classifier fails before the listing runs, with no stand-in or state write", async (t) => {
  const world = runsWorld({ classifier: null });
  t.after(() => world.cleanup());
  const before = world.w.stub.variables.get(world.edge.stateVariable);
  const result = await world.go();
  assert.equal(result.code, 1);
  assert.match(result.stderr, /runs scripts\/classify-runs\.mjs, which does not exist in the workspace/);
  assert.deepEqual(world.bin.calls("gh"), []);
  assert.deepEqual(world.classifierCalls(), []);
  assert.equal(world.w.stub.variables.get(world.edge.stateVariable), before);
  assert.equal(world.w.patches().length, 0);
  assert.equal(world.w.stub.world.dispatches.length, 0);
  assert.equal(world.w.stub.issues.length, 1);
  assert.deepEqual(world.leftovers(), []);
});

test("AC22 an uncommitted downstream snapshot is never overwritten and no listing command runs in that checkout", async (t) => {
  const world = runsWorld({ classifier: { code: 1 } });
  t.after(() => world.cleanup());
  world.git.git(path.dirname(world.downstreamDir), ["clone", "--quiet", world.git.remote(world.edge.downstreamRepo).bare, world.downstreamDir]);
  const mine = '{"note":"an edit that is not committed"}\n';
  fs.writeFileSync(path.join(world.downstreamDir, SNAPSHOT_FILE), mine);
  const result = await world.go();
  assert.equal(result.code, 1);
  assert.match(result.stderr, /already exists and is not a clean checkout/);
  assert.equal(fs.readFileSync(path.join(world.downstreamDir, SNAPSHOT_FILE), "utf8"), mine);
  assert.equal(world.w.patches().length, 0);
  assert.equal(world.w.stub.world.dispatches.length, 0);
  assert.deepEqual(world.bin.calls("gh"), []);
  assert.deepEqual(world.leftovers(), []);
});

// ---- AC23: the declared tracked-path diff ---------------------------------------------------------------------------------------------------------

const upstreamContains = (world, name) => world.git.gitMaybe(world.upstreamDir, ["cat-file", "-e", `${name}^{commit}`]).status === 0;

test("AC23 a change outside the tracked paths is no material drift, the noop cursors persist and the upstream checkout holds both commits", async (t) => {
  const world = createGitDiffWorld({ lastMerged: "tracked-change", target: "untracked-change" });
  t.after(() => world.cleanup());
  const [, change, outside] = world.upstreamShas;
  const result = await world.go();
  assert.equal(result.code, 0, `${result.stderr}\n${result.stdout}`);
  assert.deepEqual(world.w.decisions()[0], {
    correlationId: "run-5001-1",
    upstreamRepo: world.edge.upstreamRepo,
    previousSha: change,
    targetSha: outside,
    action: "noop-no-material-drift",
    dispatchedWorkflowId: null,
  });
  const after = patchedState(world);
  assert.equal(after.lastNoopHeadSha, outside);
  assert.equal(after.lastObservedHeadSha, outside);
  assert.equal(after.etag, 'W/"upstream-etag-1"');
  assert.equal(after.portfolioMainSha, world.downstreamSha);
  assert.equal(after.lastMergedUpstreamSha, change, "the merge cursor is untouched by a noop");
  assert.equal(world.w.stub.world.dispatches.length, 0);
  assert.ok(upstreamContains(world, change) && upstreamContains(world, outside), "the upstream checkout holds both SHAs");
});

test("AC23 the diff is cumulative from merge cursor to target, so a tracked change that a later commit reverted is no difference", async (t) => {
  // baseline -> content changed -> docs and workflow changed -> content reverted: only baseline..target counts
  const world = createGitDiffWorld({ lastMerged: "baseline", target: "tracked-revert" });
  t.after(() => world.cleanup());
  const result = await world.go();
  assert.equal(result.code, 0, `${result.stderr}\n${result.stdout}`);
  assert.equal(world.w.decisions()[0].action, "noop-no-material-drift", "the content matches the baseline; docs and .github are outside the tracked paths");
  assert.equal(patchedState(world).lastNoopHeadSha, world.upstreamShas[3]);
  assert.equal(world.w.stub.world.dispatches.length, 0);
});

test("AC23 a tracked change between merge cursor and target is a difference even when the head commit changed nothing tracked", async (t) => {
  const world = createGitDiffWorld({ lastMerged: "baseline", target: "untracked-change" });
  t.after(() => world.cleanup());
  const [baseline, change, outside] = world.upstreamShas;
  // the head commit alone changes no tracked path, so a diff of just that commit would have been quiet
  assert.equal(world.git.gitMaybe(world.git.remote(world.edge.upstreamRepo).work, ["diff", "--quiet", change, outside, "--", "content", "assets", "src", "index.html", "README.md"]).status, 0);
  const result = await world.go();
  assert.equal(result.code, 0, `${result.stderr}\n${result.stdout}`);
  assert.equal(world.w.decisions()[0].action, "dispatch-ai-adaptation");
  const inputs = world.w.stub.world.dispatches[0].body.inputs;
  assert.equal(inputs.sync_scope, "tracked-paths");
  assert.equal(inputs.previous_sha, baseline);
  assert.equal(inputs.upstream_sha, outside);
  assert.equal(world.w.state().lastNoopHeadSha, null);
  assert.ok(upstreamContains(world, baseline) && upstreamContains(world, outside), "the upstream checkout holds both SHAs");
});

test("AC23 a merge cursor absent from the upstream fails the job rather than counting as a difference or a quiet result", async (t) => {
  const world = createGitDiffWorld({ lastMerged: "baseline", target: "tracked-change", extra: { stateOverrides: () => ({ lastMergedUpstreamSha: "f".repeat(40), lastObservedHeadSha: "f".repeat(40) }) } });
  t.after(() => world.cleanup());
  const result = await world.go();
  assert.equal(result.code, 1);
  assert.equal(world.w.patches().length, 0);
  assert.equal(world.w.stub.world.dispatches.length, 0);
  assert.equal(world.w.stub.issues.length, 1);
  assert.deepEqual(world.w.summaryLines(), []);
  assert.deepEqual(world.w.state(), JSON.parse(world.w.stub.variables.get(world.edge.stateVariable)), "the variable is as it was");
});
