// The classification of the preflight, case by case, with the shell and the checkouts replaced by a fake that answers from a list (tests/s3/helpers/fake-preflight.mjs)
// (SPEC-03 AC20, AC21, AC28, AC40). The engine reads no command by its shape: a command's exit code is its verdict, unless the edge's preflightChecks name a
// classifier for it, and the scope that a drift asks for is what the checks declare. tests/s3/router-preflight.test.mjs runs preflights with real git and a real
// bash, and tests/preflight-declared.test.mjs covers the mechanism itself.
import assert from "node:assert/strict";
import test from "node:test";
import { chooseSyncScope, fillCheckout, PreflightError } from "../../src/routing/preflight.mjs";
import { fillPlaceholders, resolveFactory } from "../../src/lib/factory-block.mjs";
import { fakePreflight } from "./helpers/fake-preflight.mjs";
import { CHANGED_REPORT, CHECK_COMMANDS, CLEAN_REPORT, DRIFT, HELPER_COMMAND, IN_SYNC, PROBLEM_REPORT, preflightEdge, REPORT_COMMAND, STAND_IN_SCRIPTS } from "./helpers/preflight-world.mjs";
import { routerWorld } from "./helpers/harness.mjs";
import { sha, state } from "./helpers/fixtures.mjs";

const SHA0 = sha("sha0");
const SHA1 = sha("sha1");
const json = (value) => `${JSON.stringify(value)}\n`;

function world(edgeOverrides = {}, { head = SHA1, stateOverrides = {} } = {}) {
  const edge = preflightEdge(edgeOverrides);
  return routerWorld({ edge, state: state({ lastMergedUpstreamSha: SHA0, lastObservedHeadSha: SHA0, ...stateOverrides }, edge), upstream: { head }, downstream: { head: sha("main-1") }, workspaceFiles: STAND_IN_SCRIPTS });
}

/** The check that prints a report (its classifier decides), and the helper CLI whose own exit code decides. */
const report = (code, stdout) => ({ match: /check:inputs/, code, stdout });
const helper = (code, stdout, stderr = "") => ({ match: /check-drift\.mjs/, code, stdout: typeof stdout === "string" ? stdout : json(stdout), stderr });
const classifier = (code, stderr = "") => ({ match: /classify\.mjs/, code, stderr });

async function run(t, responses, edgeOverrides, options) {
  const w = world(edgeOverrides, options);
  t.after(() => w.cleanup());
  const fake = fakePreflight(responses);
  const result = await w.go({ preflightDeps: fake.deps });
  return { w, fake, result };
}

const scopeOf = (w) => w.stub.world.dispatches[0].body.inputs.sync_scope;

// ---- the placeholders and the scope -----------------------------------------------------------------------------------------------------------

test("<checkout> is the absolute upstream directory, and <factory> and <factory-dir> are the factory directory that the manifest declares", () => {
  assert.equal(fillCheckout(REPORT_COMMAND), 'npm run check:inputs -- "$UPSTREAM_DIR"');
  assert.equal(fillCheckout(HELPER_COMMAND).includes("<checkout>"), false);
  const inWorkspace = resolveFactory({});
  assert.equal(fillPlaceholders("node <factory>/bin/x.mjs <factory-dir> <checkout>", inWorkspace), 'node "$GITHUB_WORKSPACE"/bin/x.mjs . "$UPSTREAM_DIR"');
  const installed = resolveFactory({ factory: { package: "ai-sdlc-factory" } });
  assert.equal(fillPlaceholders("node <factory>/bin/x.mjs <factory-dir>", installed), 'node "$GITHUB_WORKSPACE/node_modules/ai-sdlc-factory"/bin/x.mjs node_modules/ai-sdlc-factory');
  assert.equal(fillPlaceholders("node <factory>/bin/x.mjs", resolveFactory({ factory: { package: "ai-sdlc-factory", dir: "vendor/factory" } })), 'node "$GITHUB_WORKSPACE/vendor/factory"/bin/x.mjs');
});

test("chooseSyncScope keeps a scope that the edge accepts and otherwise names one that it does", () => {
  assert.equal(chooseSyncScope("app-only", undefined), "app-only");
  assert.equal(chooseSyncScope("app-only", []), "app-only");
  assert.equal(chooseSyncScope("app-only", ["both", "docs-only", "app-only"]), "app-only");
  assert.equal(chooseSyncScope("app-only", ["both"]), "both");
  assert.equal(chooseSyncScope("app-only", ["docs-only", "both"]), "both", "both is preferred to the first scope that is listed");
  assert.equal(chooseSyncScope("app-only", ["docs-only", "other-only"]), "docs-only", "without both, the first one that is listed");
  assert.equal(chooseSyncScope("tracked-paths", ["other-only"]), "other-only");
  assert.equal(chooseSyncScope(null, undefined), "both");
});

// ---- the verdicts -----------------------------------------------------------------------------------------------------------------------------

test("AC20 the commands are the edge's, run in order from the downstream checkout, the install first, without --accept", async (t) => {
  const { fake, w, result } = await run(t, [report(1, CLEAN_REPORT), classifier(0), helper(0, IN_SYNC)]);
  assert.equal(result.code, 0, result.stderr);
  const scripts = fake.scripts();
  assert.deepEqual(scripts.slice(0, 4), [
    "npm ci --include=dev --ignore-scripts",
    'npm run check:inputs -- "$UPSTREAM_DIR"',
    'node "$GITHUB_WORKSPACE/scripts/check-drift.mjs" --downstream "$GITHUB_WORKSPACE/hub" --upstream "$UPSTREAM_DIR" --commit "$TARGET_SHA"',
    'node "$GITHUB_WORKSPACE/scripts/classify.mjs"',
  ]);
  assert.equal(scripts.some((script) => script.includes("--accept")), false);
  assert.equal(fake.checkouts.length, 2);
  assert.deepEqual(fake.checkouts.map((entry) => [entry.slug, entry.sha, entry.history ?? "shallow"]), [["initech/content", SHA1, "shallow"], ["acme/hub", sha("main-1"), "shallow"]]);
  assert.equal(w.decisions()[0].action, "noop-no-material-drift");
  const env = fake.calls[1].env;
  assert.equal(env.TARGET_SHA, SHA1);
  assert.equal(env.LAST_MERGED_SHA, SHA0);
  assert.ok(env.UPSTREAM_DIR.replace(/\\/g, "/").endsWith("/upstream/content"));
});

test("AC20 a report that its classifier calls unchanged is no drift whatever the exit status says, and the helper alone can still make it drift", async (t) => {
  const quiet = await run(t, [report(1, CLEAN_REPORT), classifier(0), helper(0, IN_SYNC)]);
  assert.equal(quiet.w.decisions()[0].action, "noop-no-material-drift");
  const helperOnly = await run(t, [report(1, CLEAN_REPORT), classifier(0), helper(1, DRIFT)]);
  assert.equal(helperOnly.w.decisions()[0].action, "dispatch-ai-adaptation");
  assert.equal(scopeOf(helperOnly.w), "app-only");
});

test("AC20 a report that its classifier calls drift is drift whatever the exit status says", async (t) => {
  for (const [stdout, code] of [[CHANGED_REPORT, 1], [CHANGED_REPORT, 0], [PROBLEM_REPORT, 1], [PROBLEM_REPORT, 0]]) {
    const { w, fake } = await run(t, [report(code, stdout), classifier(1), helper(0, IN_SYNC)]);
    assert.equal(w.decisions()[0].action, "dispatch-ai-adaptation", stdout);
    assert.equal(scopeOf(w), "docs-only");
    assert.equal(fake.calls.find((call) => /classify/.test(call.script)).env.SDLC_PREFLIGHT_EXIT_CODE, String(code), "the classifier is told what the check exited with");
  }
});

test("AC20 the preflight fails the job, without advancing state, when a classifier fails or a command exits abnormally, cannot start or does not finish", async (t) => {
  const cases = [
    ["the classifier finds no summary (exit 2)", [report(1, "Source revision: abc\nsomething else\n"), classifier(2, "no summary line\n"), helper(0, IN_SYNC)]],
    ["the classifier exits 127", [report(1, CLEAN_REPORT), classifier(127, "not found\n"), helper(0, IN_SYNC)]],
    ["the classifier cannot start", [report(1, CLEAN_REPORT), { ...classifier(0), code: null, error: "spawn ENOENT" }, helper(0, IN_SYNC)]],
    ["the classifier does not finish", [report(1, CLEAN_REPORT), { ...classifier(0), code: null, timedOut: true }, helper(0, IN_SYNC)]],
    ["the report command cannot start", [{ ...report(0, ""), code: null, error: "spawn ENOENT" }, classifier(0), helper(0, IN_SYNC)]],
    ["the report command does not finish", [{ ...report(0, ""), code: null, timedOut: true }, classifier(0), helper(0, IN_SYNC)]],
    ["the helper exits 2", [report(1, CLEAN_REPORT), classifier(0), helper(2, "", "fatal: cannot read the sources\n")]],
    ["the helper exits 3", [report(1, CLEAN_REPORT), classifier(0), helper(3, IN_SYNC)]],
    ["the helper exits 127", [report(1, CLEAN_REPORT), classifier(0), helper(127, "")]],
  ];
  for (const [label, responses] of cases) {
    const { w, result } = await run(t, responses);
    assert.equal(result.code, 1, label);
    assert.equal(w.patches().length, 0, label);
    assert.equal(w.stub.world.dispatches.length, 0, label);
    assert.deepEqual(w.state(), state({ lastMergedUpstreamSha: SHA0, lastObservedHeadSha: SHA0 }, preflightEdge()), `${label}: the variable is as it was`);
    assert.equal(w.stub.issues.length, 1, label);
    assert.match(w.stub.issues[0].title, /^\[sdlc-failure\] cascade-router \(initech\/content\)$/);
    assert.deepEqual(w.summaryLines(), [], label);
  }
});

test("AC20 the dependencies of the downstream are installed once and only for a command that uses npm, and a failing install fails the job", async (t) => {
  const failing = await run(t, [{ match: /npm ci/, code: 1, stderr: "ERESOLVE" }, report(0, CLEAN_REPORT)]);
  assert.equal(failing.result.code, 1);
  assert.match(failing.result.stderr, /installing the dependencies of acme\/hub failed/);
  assert.equal(failing.fake.scripts().filter((script) => script.includes("check:inputs")).length, 0, "no preflight runs without its dependencies");
  const plain = await run(t, [helper(0, IN_SYNC)], { preflightCommands: [HELPER_COMMAND], preflightChecks: [{ scope: "app-only" }] });
  assert.equal(plain.fake.scripts().some((script) => script.includes("npm ci")), false, "a node command needs no install");
});

test("AC21 an unchanged result with onCommitOnlyAdvance bump-provenance is dispatched with scope both when the checks ask for different scopes", async (t) => {
  const { w } = await run(t, [report(1, CLEAN_REPORT), classifier(0), helper(0, IN_SYNC)], { onCommitOnlyAdvance: "bump-provenance" });
  assert.equal(w.decisions()[0].action, "dispatch-ai-adaptation");
  assert.notEqual(w.decisions()[0].action, "noop-no-material-drift");
  assert.equal(w.stub.world.dispatches[0].body.inputs.on_commit_only_advance, "bump-provenance");
  assert.equal(scopeOf(w), "both");
  assert.equal(w.state().lastNoopHeadSha, null, "nothing was recorded as a noop");
});

test("AC21 a drifted report, a drifted helper or both are dispatched with the scope that names what changed", async (t) => {
  const cases = [
    [CHANGED_REPORT, 1, IN_SYNC, 0, "docs-only"],
    [CLEAN_REPORT, 0, DRIFT, 1, "app-only"],
    [CHANGED_REPORT, 1, DRIFT, 1, "both"],
  ];
  for (const [stdout, classified, helperAnswer, helperCode, scope] of cases) {
    const { w } = await run(t, [report(1, stdout), classifier(classified), helper(helperCode, helperAnswer)]);
    assert.equal(w.decisions()[0].action, "dispatch-ai-adaptation", scope);
    assert.equal(scopeOf(w), scope);
    assert.equal(w.stub.world.dispatches[0].body.inputs.on_commit_only_advance, "noop");
  }
});

test("AC21 a sync scope that the edge's workflow does not accept is replaced by one that it does", async (t) => {
  const edge = preflightEdge();
  const w = routerWorld({ edge, state: state({ lastMergedUpstreamSha: SHA0, lastObservedHeadSha: SHA0 }, edge), upstream: { head: SHA1 }, downstream: { head: sha("main-1") }, manifestEdges: [{ ...edge, syncScopes: ["both"] }], workspaceFiles: STAND_IN_SCRIPTS });
  t.after(() => w.cleanup());
  const fake = fakePreflight([report(0, CLEAN_REPORT), classifier(0), helper(1, DRIFT)]);
  await w.go({ preflightDeps: fake.deps });
  assert.equal(scopeOf(w), "both", "app-only is not accepted, both is");
});

test("AC40 the helper's three exit codes map to no drift, drift and a failed preflight", async (t) => {
  const ok = await run(t, [report(0, CLEAN_REPORT), classifier(0), helper(0, IN_SYNC)]);
  const drifted = await run(t, [report(0, CLEAN_REPORT), classifier(0), helper(1, DRIFT)]);
  const fatal = await run(t, [report(0, CLEAN_REPORT), classifier(0), helper(2, "", "x\n")]);
  assert.equal(ok.w.decisions()[0].action, "noop-no-material-drift");
  assert.equal(drifted.w.decisions()[0].action, "dispatch-ai-adaptation");
  assert.equal(fatal.result.code, 1);
  assert.match(fatal.result.stderr, /check-drift\.mjs.* exited with 2: x/);
});

test("AC28 a failed check as the router sees it leaves etag, merge cursor, noop cursor and pull-request pointers alone and upserts one issue", async (t) => {
  const { w, result } = await run(t, [report(0, CLEAN_REPORT), classifier(0), helper(2, "", "boom\n")], {}, { stateOverrides: { etag: 'W/"keep"', lastNoopHeadSha: sha("old-noop"), openPrNumber: 3, openPrTargetSha: sha("open") } });
  assert.equal(result.code, 1);
  assert.equal(w.patches().length, 0);
  const after = w.state();
  assert.equal(after.etag, 'W/"keep"');
  assert.equal(after.lastMergedUpstreamSha, SHA0);
  assert.equal(after.lastNoopHeadSha, sha("old-noop"));
  assert.equal(after.openPrTargetSha, sha("open"));
  assert.equal(w.stub.issues.length, 1);
});

test("the plain check by exit status: 0 is no difference, 1 a difference, anything else a failure of the job", async (t) => {
  const edge = { preflightCommands: ['git -C <checkout> diff --quiet "$LAST_MERGED_SHA" "$TARGET_SHA" -- content'], preflightChecks: [{ scope: "tracked-paths" }], syncScopes: ["both", "tracked-paths"] };
  const same = await run(t, [{ match: /diff --quiet/, code: 0 }], edge);
  assert.equal(same.w.decisions()[0].action, "noop-no-material-drift");
  assert.deepEqual(same.fake.checkouts.map((entry) => [entry.slug, entry.history, entry.mustContain]), [["initech/content", "full", [SHA0]]], "the upstream checkout holds both commits and no downstream checkout is made for a git command");
  const differs = await run(t, [{ match: /diff --quiet/, code: 1 }], edge);
  assert.equal(differs.w.decisions()[0].action, "dispatch-ai-adaptation");
  assert.equal(scopeOf(differs.w), "tracked-paths");
  for (const code of [2, 128, 129]) {
    const failed = await run(t, [{ match: /diff --quiet/, code }], edge);
    assert.equal(failed.result.code, 1, String(code));
    assert.equal(failed.w.patches().length, 0);
  }
});

test("PreflightError is what a preflight that cannot decide throws, and CHECK_COMMANDS are the two commands of the default edge", () => {
  assert.equal(new PreflightError("x").name, "PreflightError");
  assert.deepEqual(CHECK_COMMANDS, [REPORT_COMMAND, HELPER_COMMAND]);
});
