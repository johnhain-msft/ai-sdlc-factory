// The router's preflight as the manifest declares it (design section E2). The engine knows no kind of command. Every `preflightCommands` entry is a check whose
// verdict is its exit code (0 no drift, 1 drift, anything else a failure) unless `preflightChecks[i].classifier` names a command that judges it from what the check
// printed. A check may say which `scope` its drift asks the dispatch for and which `noopAction` an unchanged result is recorded as.
//
// The shell and the checkouts are replaced by a fake that answers from a list (tests/s3/helpers/fake-preflight.mjs); tests/s3/helper-cli-consumer.test.mjs runs the
// contract with a real bash and real processes.

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import YAML from "yaml";
import { renderFleet } from "../src/reconcile.mjs";
import * as preflightModule from "../src/routing/preflight.mjs";
import { fakePreflight } from "./s3/helpers/fake-preflight.mjs";
import { routerWorld } from "./s3/helpers/harness.mjs";
import { sha, state } from "./s3/helpers/fixtures.mjs";
import { CHANGED_REPORT, CLASSIFIER, CLEAN_REPORT, nativePath, preflightEdge, REPORT_COMMAND, STAND_IN_SCRIPTS } from "./s3/helpers/preflight-world.mjs";
import { createWorkspace, referenceRequest } from "./helpers/mini-fleet.mjs";

const ENGINE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SHA0 = sha("sha0");
const SHA1 = sha("sha1");

/**
 * @param {object} [edgeOverrides] overrides of the synthetic edge
 * @param {object} [options]
 * @param {object} [options.workspace] more options of routerWorld
 * @param {Record<string, string>} [options.files] workspace files besides the two stand-in scripts that the default edge's commands name
 * @param {string[]} [options.omit] workspace files to leave out (a script that the manifest names and the orchestrator does not have)
 */
function world(edgeOverrides = {}, { head = SHA1, stateOverrides = {}, workspace, files = {}, omit = [] } = {}) {
  const workspaceFiles = { ...STAND_IN_SCRIPTS, ...files };
  for (const omitted of omit) delete workspaceFiles[omitted];
  const edge = preflightEdge(edgeOverrides);
  return routerWorld({
    edge,
    state: state({ lastMergedUpstreamSha: SHA0, lastObservedHeadSha: SHA0, ...stateOverrides }, edge),
    upstream: { head },
    downstream: { head: sha("main-1") },
    workspaceFiles,
    ...(workspace ?? {}),
  });
}

const check = (code, stdout = "", stderr = "") => ({ match: /check:inputs/, code, stdout, stderr });
const helper = (code, stdout = "", stderr = "") => ({ match: /check-drift\.mjs/, code, stdout, stderr });
const classifier = (code, stderr = "", then) => ({ match: /classify\.mjs/, code, stderr, then });

async function run(t, responses, edgeOverrides, options) {
  const w = world(edgeOverrides, options);
  t.after(() => w.cleanup());
  const fake = fakePreflight(responses);
  const result = await w.go({ preflightDeps: fake.deps });
  return { w, fake, result };
}

const scopeOf = (w) => w.stub.world.dispatches[0].body.inputs.sync_scope;
const classifierCalls = (fake) => fake.calls.filter((call) => /classify\.mjs/.test(call.script));
/** Answers every command that the preflight runs except the install of the downstream's dependencies. */
const anything = (code) => ({ match: /^(?!npm ci )/, code });

// ---- the default verdict: the exit code --------------------------------------------------------------------------------------------------------

test("without a classifier the exit code of a command is its verdict: 0 no drift, 1 drift, anything else fails the job and writes nothing", async (t) => {
  const edge = { preflightCommands: ["git -C <checkout> diff --quiet"], preflightChecks: [{}] };
  const same = await run(t, [{ match: /diff --quiet/, code: 0 }], edge);
  assert.equal(same.w.decisions()[0].action, "noop-no-material-drift");
  const differs = await run(t, [{ match: /diff --quiet/, code: 1 }], edge);
  assert.equal(differs.w.decisions()[0].action, "dispatch-ai-adaptation");
  assert.equal(scopeOf(differs.w), "both", "a drift that asks for no scope asks for both");
  for (const code of [2, 3, 127, 128]) {
    const failed = await run(t, [{ match: /diff --quiet/, code }], edge);
    assert.equal(failed.result.code, 1, String(code));
    assert.equal(failed.w.patches().length, 0);
    assert.equal(failed.w.stub.world.dispatches.length, 0);
    assert.equal(failed.w.stub.issues.length, 1);
  }
});

test("no preflightChecks at all is the same as an empty check for every command", async (t) => {
  const { w } = await run(t, [check(0, CLEAN_REPORT), helper(1, "drift\n")], { preflightChecks: undefined });
  assert.equal(w.decisions()[0].action, "dispatch-ai-adaptation");
  assert.equal(scopeOf(w), "both");
});

test("the commands run in order from the downstream checkout (a git command from the workspace), after the install, and none runs with --accept", async (t) => {
  const { fake } = await run(t, [check(0, CLEAN_REPORT), helper(0), classifier(0)]);
  const scripts = fake.scripts();
  assert.equal(scripts[0], "npm ci --include=dev --ignore-scripts");
  assert.equal(scripts[1], 'npm run check:inputs -- "$UPSTREAM_DIR"');
  assert.equal(scripts[2], 'node "$GITHUB_WORKSPACE/scripts/check-drift.mjs" --downstream "$GITHUB_WORKSPACE/hub" --upstream "$UPSTREAM_DIR" --commit "$TARGET_SHA"');
  assert.equal(scripts.some((script) => script.includes("--accept")), false);
  assert.equal(fake.checkouts.length, 2);
  const git = await run(t, [{ match: /diff --quiet/, code: 0 }], { preflightCommands: ['git -C <checkout> diff --quiet "$LAST_MERGED_SHA" "$TARGET_SHA"'], preflightChecks: [{}] });
  assert.deepEqual(git.fake.checkouts.map((entry) => [entry.slug, entry.history, entry.mustContain]), [["initech/content", "full", [SHA0]]], "a git command needs the history of both commits and no downstream checkout");
  assert.equal(git.fake.calls[0].cwd, git.w.workspace.dir, "and runs in the workspace");
});

// ---- the classifier contract -------------------------------------------------------------------------------------------------------------------

test("a classifier judges the check from what it printed: 0 no drift, 1 drift, anything else a failure", async (t) => {
  for (const [code, action] of [[0, "noop-no-material-drift"], [1, "dispatch-ai-adaptation"]]) {
    const { w, fake } = await run(t, [check(1, CHANGED_REPORT), helper(0), classifier(code)]);
    assert.equal(w.decisions()[0].action, action, `classifier exit ${code}`);
    assert.equal(classifierCalls(fake).length, 1, "only the check that names a classifier has one");
  }
  for (const code of [2, 3, 127]) {
    const { w, result, fake } = await run(t, [check(0, CLEAN_REPORT), helper(0), classifier(code, "no summary line\n")]);
    assert.equal(result.code, 1, String(code));
    assert.match(result.stderr, new RegExp(`the classifier .*classify\\.mjs.* of the check .*check:inputs.* exited with ${code}: no summary line`));
    assert.equal(w.patches().length, 0);
    assert.equal(w.stub.world.dispatches.length, 0);
    assert.equal(w.stub.issues.length, 1);
    assert.equal(fake.scripts().filter((script) => /check-drift/.test(script)).length, 1, "every command ran before any was judged");
  }
});

test("the classifier is told which check it judges, with the command's exit code and the two streams in files, and removes nothing it did not make", async (t) => {
  const seen = [];
  const { fake, w } = await run(t, [
    check(1, CHANGED_REPORT, "a warning\n"),
    helper(0),
    classifier(1, "", (call) =>
      seen.push({
        env: call.env,
        stdout: fs.readFileSync(nativePath(call.env.SDLC_PREFLIGHT_STDOUT_FILE), "utf8"),
        stderr: fs.readFileSync(nativePath(call.env.SDLC_PREFLIGHT_STDERR_FILE), "utf8"),
      }),
    ),
  ]);
  assert.equal(seen.length, 1);
  const [{ env, stdout, stderr }] = seen;
  assert.equal(env.SDLC_PREFLIGHT_INDEX, "0", "the zero-based position in preflightCommands, which is also its position in preflightChecks");
  assert.equal(env.SDLC_PREFLIGHT_COMMAND, REPORT_COMMAND, "the command as the manifest declares it");
  assert.equal(env.SDLC_PREFLIGHT_EXIT_CODE, "1");
  assert.equal(stdout, CHANGED_REPORT);
  assert.equal(stderr, "a warning\n");
  assert.equal(env.TARGET_SHA, SHA1);
  assert.equal(env.LAST_MERGED_SHA, SHA0);
  assert.ok(env.UPSTREAM_DIR.replace(/\\/g, "/").endsWith("/upstream/content"));
  assert.ok(env.GITHUB_WORKSPACE);
  for (const secret of ["APP_PRIVATE_KEY", "ISSUES_TOKEN", "APP_CLIENT_ID"]) assert.equal(secret in env, false, `${secret} never reaches a classifier`);
  assert.equal(fake.calls.find((call) => /classify/.test(call.script)).cwd, fake.calls.find((call) => /check:inputs/.test(call.script)).cwd, "in the directory of the check");
  assert.equal(w.decisions()[0].action, "dispatch-ai-adaptation");
});

test("the files that a classifier reads are removed when the preflight ends, whatever the verdict", async (t) => {
  for (const code of [0, 1, 2]) {
    const files = [];
    await run(t, [check(0, CLEAN_REPORT), helper(0), classifier(code, "", (call) => files.push(nativePath(call.env.SDLC_PREFLIGHT_STDOUT_FILE), nativePath(call.env.SDLC_PREFLIGHT_STDERR_FILE)))]);
    assert.equal(files.length, 2);
    for (const file of files) assert.equal(fs.existsSync(file), false, `${code}: ${file}`);
  }
});

test("a classifier decides even when the command exited abnormally, and a command that cannot run is a failure whatever a classifier would say", async (t) => {
  const strange = await run(t, [check(127, "", "npm: not found\n"), helper(0), classifier(1)]);
  assert.equal(strange.w.decisions()[0].action, "dispatch-ai-adaptation", "the classifier owns the verdict, so an exit code of 127 is what it was told, not what the router judges");
  assert.equal(classifierCalls(strange.fake)[0].env.SDLC_PREFLIGHT_EXIT_CODE, "127");
  for (const [label, response] of [
    ["could not start", { ...check(0), code: null, error: "spawn ENOENT" }],
    ["timed out", { ...check(0), code: null, timedOut: true }],
  ]) {
    const { w, result, fake } = await run(t, [response, helper(0), classifier(0)]);
    assert.equal(result.code, 1, label);
    assert.equal(classifierCalls(fake).length, 0, `${label}: nothing to classify`);
    assert.equal(w.patches().length, 0, label);
  }
  for (const [label, response] of [
    ["the classifier could not start", { ...classifier(0), code: null, error: "spawn ENOENT" }],
    ["the classifier timed out", { ...classifier(0), code: null, timedOut: true }],
  ]) {
    const { w, result } = await run(t, [check(0, CLEAN_REPORT), helper(0), response]);
    assert.equal(result.code, 1, label);
    assert.equal(w.patches().length, 0, label);
    assert.equal(w.stub.world.dispatches.length, 0, label);
  }
});

// ---- scopes and noop actions -------------------------------------------------------------------------------------------------------------------

test("a drift asks for the scope of the checks that drifted: one scope when they agree or only one declares it, both when they differ", async (t) => {
  const cases = [
    ["the first check alone", [check(0, CHANGED_REPORT), helper(0), classifier(1)], "docs-only"],
    ["the second check alone", [check(0, CLEAN_REPORT), helper(1), classifier(0)], "app-only"],
    ["both checks", [check(0, CHANGED_REPORT), helper(1), classifier(1)], "both"],
  ];
  for (const [label, responses, scope] of cases) {
    const { w } = await run(t, responses);
    assert.equal(w.decisions()[0].action, "dispatch-ai-adaptation", label);
    assert.equal(scopeOf(w), scope, label);
    assert.equal(w.stub.world.dispatches[0].body.inputs.on_commit_only_advance, "noop", label);
  }
  const same = await run(t, [check(1), helper(1)], { preflightChecks: [{ scope: "docs-only" }, { scope: "docs-only" }] });
  assert.equal(scopeOf(same.w), "docs-only", "two checks that ask for the same scope ask for it once");
  const unscoped = await run(t, [check(1), helper(1)], { preflightChecks: [{ scope: "app-only" }, {}] });
  assert.equal(scopeOf(unscoped.w), "app-only", "a check that asks for no scope does not widen the one that another asks for");
});

test("a scope that the edge's workflow does not accept is replaced by one that it does", async (t) => {
  const both = await run(t, [check(0), helper(0), classifier(1)], { syncScopes: ["app-only", "both"] });
  assert.equal(scopeOf(both.w), "both", "docs-only is not accepted, and both is preferred to the first scope that is listed");
  const first = await run(t, [check(0), helper(0), classifier(1)], { syncScopes: ["app-only", "other-only"] });
  assert.equal(scopeOf(first.w), "app-only", "no both: the first one that the workflow accepts");
});

test("a commit-only advance with bump-provenance is dispatched with the one scope that every check declares, and both when they differ or none does", async (t) => {
  const one = await run(t, [check(0, CLEAN_REPORT), helper(0), classifier(0)], { onCommitOnlyAdvance: "bump-provenance", preflightChecks: [{ scope: "docs-only", classifier: CLASSIFIER }, { scope: "docs-only" }] });
  assert.equal(one.w.decisions()[0].action, "dispatch-ai-adaptation");
  assert.equal(scopeOf(one.w), "docs-only");
  assert.equal(one.w.stub.world.dispatches[0].body.inputs.on_commit_only_advance, "bump-provenance");
  assert.equal(one.w.state().lastNoopHeadSha, null, "nothing was recorded as a noop");
  const two = await run(t, [check(0, CLEAN_REPORT), helper(0), classifier(0)], { onCommitOnlyAdvance: "bump-provenance" });
  assert.equal(scopeOf(two.w), "both");
  const none = await run(t, [check(0), helper(0)], { onCommitOnlyAdvance: "bump-provenance", preflightChecks: [{}, {}] });
  assert.equal(scopeOf(none.w), "both");
});

test("an unchanged result is recorded as the noop action that a check declares, else as no material drift", async (t) => {
  const plain = await run(t, [check(0, CLEAN_REPORT), helper(0), classifier(0)]);
  assert.equal(plain.w.decisions()[0].action, "noop-no-material-drift");
  const snapshot = await run(t, [check(0, CLEAN_REPORT), helper(0), classifier(0)], { preflightChecks: [{ scope: "docs-only", classifier: CLASSIFIER, noopAction: "noop-unchanged-snapshot" }, { scope: "app-only" }] });
  assert.equal(snapshot.w.decisions()[0].action, "noop-unchanged-snapshot");
  assert.equal(snapshot.w.state().lastNoopHeadSha, SHA1);
  const drifted = await run(t, [check(0, CHANGED_REPORT), helper(0), classifier(1)], { preflightChecks: [{ scope: "docs-only", classifier: CLASSIFIER, noopAction: "noop-unchanged-snapshot" }, { scope: "app-only" }] });
  assert.equal(drifted.w.decisions()[0].action, "dispatch-ai-adaptation", "the noop action only names a result that is unchanged");
});

// ---- the manifest is part of the decision ------------------------------------------------------------------------------------------------------

test("an unreadable manifest, or one without the edge, fails an edge that has preflight commands and writes nothing", async (t) => {
  const unreadable = (w) => fs.writeFileSync(path.join(w.workspace.dir, "sdlc.yaml"), "projects: [unterminated\n");
  const withoutEdge = (edge) => ({ manifestEdges: [{ ...edge, upstreamKey: "elsewhere", edgeId: "elsewhere", upstreamSlug: "ELSEWHERE", stateVariable: "SDLC_SYNC_STATE_ELSEWHERE" }] });
  for (const [label, options, prepare, why] of [
    ["not valid YAML", () => ({}), unreadable, /cannot be read/],
    ["no edge of that upstream", withoutEdge, () => {}, /has no dependencyEdges entry with the upstreamKey/],
    ["no manifest in the workspace", () => ({}), (w) => fs.rmSync(path.join(w.workspace.dir, "sdlc.yaml")), /sdlc\.yaml is not in /],
  ]) {
    const edge = preflightEdge();
    const w = routerWorld({ edge, state: state({ lastMergedUpstreamSha: SHA0, lastObservedHeadSha: SHA0 }, edge), upstream: { head: SHA1 }, downstream: { head: sha("main-1") }, ...options(edge) });
    t.after(() => w.cleanup());
    prepare(w);
    const fake = fakePreflight([check(0, CLEAN_REPORT), helper(0), classifier(0)]);
    const result = await w.go({ preflightDeps: fake.deps });
    assert.equal(result.code, 1, label);
    assert.match(result.stderr, /preflightChecks/, label);
    assert.match(result.stderr, why, label);
    assert.equal(fake.calls.length, 0, `${label}: nothing ran`);
    assert.equal(w.patches().length, 0, label);
    assert.equal(w.stub.world.dispatches.length, 0, label);
    assert.equal(w.stub.issues.length, 1, label);
  }
});

test("an edge without preflight commands still routes when the manifest cannot be read, and says so", async (t) => {
  const edge = preflightEdge({ preflightCommands: [], preflightChecks: undefined });
  const w = routerWorld({ edge, state: state({ lastMergedUpstreamSha: SHA0, lastObservedHeadSha: SHA0 }, edge), upstream: { head: SHA1 }, downstream: { head: sha("main-1") } });
  t.after(() => w.cleanup());
  fs.writeFileSync(path.join(w.workspace.dir, "sdlc.yaml"), "projects: [unterminated\n");
  const result = await w.go();
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /sdlc\.yaml is not read for the sync scopes/);
  assert.equal(w.decisions()[0].action, "dispatch-ai-adaptation");
});

test("a manifest edge whose preflightChecks do not match its preflightCommands fails the preflight instead of guessing", async (t) => {
  const { w, result, fake } = await run(t, [check(0), helper(0)], { preflightChecks: [{ scope: "docs-only" }] });
  assert.equal(result.code, 1);
  assert.match(result.stderr, /1 preflightChecks for 2 preflightCommands/);
  assert.equal(fake.calls.length, 0);
  assert.equal(w.patches().length, 0);
});

test("<factory> and <factory-dir> in a command or a classifier are the factory directory that the manifest declares; SDLC_MANIFEST reaches them", async (t) => {
  const edge = preflightEdge({ preflightCommands: ["node <factory>/bin/probe.mjs <factory-dir>"], preflightChecks: [{ classifier: 'node <factory>/bin/classify.mjs' }] });
  const w = routerWorld({
    edge,
    state: state({ lastMergedUpstreamSha: SHA0, lastObservedHeadSha: SHA0 }, edge),
    upstream: { head: SHA1 },
    downstream: { head: sha("main-1") },
    env: { SDLC_MANIFEST: "config/fleet.yaml" },
    workspaceFiles: { "node_modules/ai-sdlc-factory/bin/probe.mjs": "// the probe\n", "node_modules/ai-sdlc-factory/bin/classify.mjs": "// the classifier\n" },
  });
  t.after(() => w.cleanup());
  fs.mkdirSync(path.join(w.workspace.dir, "config"), { recursive: true });
  fs.renameSync(path.join(w.workspace.dir, "sdlc.yaml"), path.join(w.workspace.dir, "config", "fleet.yaml"));
  fs.appendFileSync(path.join(w.workspace.dir, "config", "fleet.yaml"), "factory:\n  package: ai-sdlc-factory\n  dir: node_modules/ai-sdlc-factory\n");
  const fake = fakePreflight([{ match: /probe\.mjs/, code: 0 }, { match: /bin\/classify\.mjs/, code: 0 }]);
  const result = await w.go({ preflightDeps: fake.deps });
  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(fake.scripts().filter((script) => !script.startsWith("npm ")), ['node "$GITHUB_WORKSPACE/node_modules/ai-sdlc-factory"/bin/probe.mjs node_modules/ai-sdlc-factory', 'node "$GITHUB_WORKSPACE/node_modules/ai-sdlc-factory"/bin/classify.mjs']);
  assert.equal(fake.calls.every((call) => call.env.SDLC_MANIFEST === "config/fleet.yaml"), true, "the scrubbed environment keeps the manifest location");
});

// ---- a script that is not there is an error, not a drift ---------------------------------------------------------------------------------------

const HELPER_SCRIPT = "scripts/check-drift.mjs";
const CLASSIFIER_SCRIPT = "scripts/classify.mjs";

test("a node script that the workspace does not have fails the preflight instead of reading as a drift, whatever exit code the shell would have given", async (t) => {
  // node exits 1 for a file that is not there, and exit 1 is a drift: without the guard the router dispatches a cascade for a manifest that names a missing helper
  for (const code of [1, 0, 2, 127]) {
    const { w, result, fake } = await run(t, [check(0, CLEAN_REPORT), helper(code), classifier(0)], {}, { omit: [HELPER_SCRIPT] });
    assert.equal(result.code, 1, `exit ${code}: ${result.stdout}`);
    assert.match(result.stderr, /the preflight command 'node "\$GITHUB_WORKSPACE\/scripts\/check-drift\.mjs"[^']*' runs scripts\/check-drift\.mjs, which does not exist in the workspace/, `exit ${code}`);
    assert.match(result.stderr, /exit 1 is a drift/);
    assert.deepEqual(fake.scripts().filter((script) => !script.startsWith("npm ci")), [], `exit ${code}: no check ran, so nothing was run in its place`);
    assert.equal(w.patches().length, 0, "nothing is written");
    assert.equal(w.stub.world.dispatches.length, 0, "nothing is dispatched");
    assert.equal(w.stub.issues.length, 1, "one issue says why");
  }
});

test("a classifier script that the workspace does not have fails the preflight too, and no check runs before the guard has looked at every command", async (t) => {
  const { w, result, fake } = await run(t, [check(0, CLEAN_REPORT), helper(1, "drift\n"), classifier(1)], {}, { omit: [CLASSIFIER_SCRIPT] });
  assert.equal(result.code, 1);
  assert.match(result.stderr, /the preflight classifier 'node "\$GITHUB_WORKSPACE\/scripts\/classify\.mjs"' of the check 'npm run check:inputs -- <checkout>' runs scripts\/classify\.mjs, which does not exist in the workspace/);
  assert.deepEqual(fake.scripts().filter((script) => !script.startsWith("npm ci")), []);
  assert.equal(w.stub.world.dispatches.length, 0);
  assert.equal(w.patches().length, 0);
});

test("a node script is looked for where node would look: $GITHUB_WORKSPACE, $UPSTREAM_DIR (<checkout>), the downstream checkout for a relative path, after the options of node", async (t) => {
  // [what the command names, the command, the file (workspace-relative) that node would open]
  const cases = [
    ["a relative path, from the downstream checkout", "node scripts/probe.mjs --flag", "hub/scripts/probe.mjs"],
    ["a relative path with ./", "node ./scripts/probe.mjs", "hub/scripts/probe.mjs"],
    ["options of node come first", 'node --no-warnings --frozen-intrinsics "$GITHUB_WORKSPACE/scripts/probe.mjs" --flag', "scripts/probe.mjs"],
    ["the braces form of the variable", 'node "${GITHUB_WORKSPACE}/scripts/probe.mjs"', "scripts/probe.mjs"],
    ["a quoted path with a space", 'node "$GITHUB_WORKSPACE/my scripts/probe.mjs"', "my scripts/probe.mjs"],
    ["the upstream checkout", "node <checkout>/tools/probe.mjs", "upstream/content/tools/probe.mjs"],
    ["a CommonJS script", 'node "$GITHUB_WORKSPACE/scripts/probe.cjs"', "scripts/probe.cjs"],
    ["a script that another command follows", "node scripts/probe.mjs --flag;echo done", "hub/scripts/probe.mjs"],
    ["a script whose output is piped", "node scripts/probe.mjs|tee report.txt", "hub/scripts/probe.mjs"],
    ["a script whose output is redirected", "node scripts/probe.mjs>report.txt", "hub/scripts/probe.mjs"],
    ["a script after the end of the options", "node --no-warnings -- scripts/probe.mjs", "hub/scripts/probe.mjs"],
  ];
  for (const [label, command, file] of cases) {
    const edge = { preflightCommands: [command], preflightChecks: [{}] };
    const there = await run(t, [{ match: /probe\./, code: 0 }], edge, { files: { [file]: "// the script\n" } });
    assert.equal(there.result.code, 0, `${label}, present: ${there.result.stderr}`);
    assert.equal(there.w.decisions()[0].action, "noop-no-material-drift", label);
    const absent = await run(t, [{ match: /probe\./, code: 1 }], edge);
    assert.equal(absent.result.code, 1, `${label}, absent`);
    assert.match(absent.result.stderr, new RegExp(`runs ${file.replace(/[.]/g, "\\.")}, which does not exist`), label);
    assert.equal(absent.w.stub.world.dispatches.length, 0, label);
  }
});

test("only a node script that is named plainly is looked for: nothing else is guarded, and the exit code stays the verdict of every command that is run", async (t) => {
  const unguarded = [
    ["a package script", "npm run check:inputs -- <checkout>"],
    ["a git command", 'git -C <checkout> diff --quiet "$LAST_MERGED_SHA" "$TARGET_SHA"'],
    ["code given to node", `node -e "process.exit(1)"`],
    ["a module that node loads first", 'node --import ./preload.mjs "$GITHUB_WORKSPACE/scripts/probe.mjs"'],
    ["a path that a variable makes", 'node "$TOOLS/probe.mjs"'],
    ["a path that a command makes", 'node "$(pwd)/probe.mjs"'],
    ["an absolute path", "node /opt/tools/probe.mjs"],
    ["a path with a glob", "node scripts/*.mjs"],
    ["a file that is not a script", "node scripts/probe"],
    ["a script behind another command", "cd tools && node probe.mjs"],
  ];
  for (const [label, command] of unguarded) {
    const edge = { preflightCommands: [command], preflightChecks: [{}] };
    const drift = await run(t, [anything(1)], edge);
    assert.equal(drift.result.code, 0, `${label}: ${drift.result.stderr}`);
    assert.equal(drift.w.decisions()[0].action, "dispatch-ai-adaptation", `${label}: exit 1 is a drift`);
    const failed = await run(t, [anything(2)], edge);
    assert.equal(failed.result.code, 1, `${label}: any other exit code fails the preflight`);
    assert.match(failed.result.stderr, /exited with 2/, label);
  }
  // a script that is there keeps the exit-code verdict: 0 no drift, 1 drift, anything else a failure
  for (const [code, action] of [[0, "noop-no-material-drift"], [1, "dispatch-ai-adaptation"]]) {
    const { w } = await run(t, [check(0, CLEAN_REPORT), helper(code), classifier(0)]);
    assert.equal(w.decisions()[0].action, action, `the helper exits ${code}`);
  }
  const failed = await run(t, [check(0, CLEAN_REPORT), helper(2), classifier(0)]);
  assert.equal(failed.result.code, 1);
  assert.match(failed.result.stderr, /exited with 2/);
});

test("an edge that has no preflight commands has nothing to look for", async (t) => {
  const { result, w } = await run(t, [], { preflightCommands: [], preflightChecks: undefined }, { omit: [HELPER_SCRIPT, CLASSIFIER_SCRIPT] });
  assert.equal(result.code, 0, result.stderr);
  assert.equal(w.decisions()[0].action, "dispatch-ai-adaptation");
});

// ---- the provenance of a second file is logged, never decided on ------------------------------------------------------------------------------

test("logProvenance: each declared file is compared with the edge's provenance and a difference is logged, never decided on", async (t) => {
  const edge = preflightEdge({ preflightCommands: [], preflightChecks: undefined, logProvenance: [{ file: "apps/site/sources.json", pointer: "/_provenance/commit" }, { file: "apps/site/missing.json", pointer: "/commit" }] });
  const w = routerWorld({
    edge,
    state: state({ lastMergedUpstreamSha: SHA0, lastObservedHeadSha: SHA0 }, edge),
    upstream: { head: SHA1 },
    downstream: { head: sha("main-1"), files: { "apps/site/sources.json": JSON.stringify({ _provenance: { commit: sha("other-commit") } }) } },
  });
  t.after(() => w.cleanup());
  const result = await w.go();
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /provenance mismatch \(recorded, not an error\): docs\/provenance\.json records .*, apps\/site\/sources\.json records [0-9a-f]{40}; docs\/provenance\.json is authoritative/);
  assert.match(result.stdout, /apps\/site\/missing\.json does not exist in acme\/hub; its provenance is not compared/);
  assert.equal(w.decisions()[0].action, "dispatch-ai-adaptation", "the log decides nothing");
  const quiet = routerWorld({ edge: preflightEdge({ preflightCommands: [], preflightChecks: undefined }), state: state({ lastMergedUpstreamSha: SHA0, lastObservedHeadSha: SHA0 }, edge), upstream: { head: SHA1 }, downstream: { head: sha("main-1") } });
  t.after(() => quiet.cleanup());
  await quiet.go();
  assert.deepEqual(quiet.stub.calls("GET", "/contents/apps/"), [], "an edge that declares none reads none");
});

// ---- the declaration in the manifest ----------------------------------------------------------------------------------------------------------

const AI = 1;
function manifestErrors(t, mutate) {
  const work = createWorkspace(t, { mutate });
  const result = renderFleet(referenceRequest(), { cwd: work.dir });
  return result.ok ? [] : result.result.validationResults.flatMap((entry) => entry.errors);
}

test("preflightChecks: one entry for each preflight command, each scope one that the edge declares", (t) => {
  const withChecks = (checks, scopes = ["both", "content-only", "runs-only"], commands = ["a", "b"]) => (manifest) => {
    const edge = manifest.dependencyEdges[AI];
    edge.syncScopes = scopes;
    edge.preflightCommands = commands;
    edge.preflightChecks = checks;
  };
  assert.deepEqual(manifestErrors(t, withChecks([{ scope: "content-only", classifier: "node scripts/c.mjs" }, { scope: "runs-only", noopAction: "noop-unchanged-snapshot" }])), []);
  assert.deepEqual(manifestErrors(t, withChecks([{}, {}])), []);
  const count = manifestErrors(t, withChecks([{}]));
  assert.ok(count.some((error) => error.startsWith("edge-preflight-checks-count: ") && error.includes("1 preflightChecks for 2 preflightCommands")), count.join("\n"));
  const none = manifestErrors(t, withChecks([{}, {}], undefined, []));
  assert.ok(none.some((error) => error.startsWith("edge-preflight-checks-count: ")), "checks without commands");
  const undeclared = manifestErrors(t, withChecks([{ scope: "content-only" }, { scope: "other-only" }]));
  assert.ok(undeclared.some((error) => error.startsWith("edge-preflight-scope-undeclared: ") && error.includes("other-only")), undeclared.join("\n"));
  for (const bad of [{ scope: "Bad Scope" }, { classifier: "" }, { noopAction: "noop-304" }, { extra: true }, { classifier: 5 }]) {
    const errors = manifestErrors(t, withChecks([bad, {}]));
    assert.ok(errors.some((error) => error.startsWith("schema-validation: ") && error.includes("preflightChecks/0")), `${JSON.stringify(bad)}: ${errors.join(" | ")}`);
  }
  const text = manifestErrors(t, (manifest) => {
    manifest.dependencyEdges[AI].preflightCommands = ["a"];
    manifest.dependencyEdges[AI].preflightChecks = [{ classifier: "echo ${{ secrets.X }}" }];
  });
  assert.ok(text.some((error) => error.startsWith("manifest-expression-opener: ")), "every string of the block is data, never an expression");
});

test("logProvenance: a list of { file, pointer }, the file inside the repository", (t) => {
  const withLog = (entries) => (manifest) => void (manifest.dependencyEdges[AI].logProvenance = entries);
  assert.deepEqual(manifestErrors(t, withLog([{ file: "apps/site/sources.json", pointer: "/_provenance/commit" }])), []);
  for (const bad of [[{ file: "/etc/passwd", pointer: "/a" }], [{ file: "../x.json", pointer: "/a" }], [{ file: "a.json", pointer: "a" }], [{ file: "a.json" }], [{ pointer: "/a" }], [{ file: "a.json", pointer: "/a", extra: 1 }], "a.json"]) {
    const errors = manifestErrors(t, withLog(bad));
    assert.ok(errors.some((error) => error.startsWith("schema-validation: ") && error.includes("logProvenance")), `${JSON.stringify(bad)}: ${errors.join(" | ")}`);
  }
});

test("the declared checks change nothing that is rendered: the router matrix and the evidence capture are the same with and without them", (t) => {
  const render = (mutate) => {
    const work = createWorkspace(t, { mutate });
    const result = renderFleet(referenceRequest(), { cwd: work.dir });
    assert.equal(result.ok, true, JSON.stringify(result.result));
    return result.files;
  };
  const plain = render((manifest) => void (manifest.dependencyEdges[AI].preflightCommands = ["a", "b"]));
  const declared = render((manifest) => {
    const edge = manifest.dependencyEdges[AI];
    edge.syncScopes = ["both", "content-only"];
    edge.preflightCommands = ["a", "b"];
    edge.preflightChecks = [{ scope: "content-only", classifier: "node scripts/c.mjs" }, {}];
    edge.logProvenance = [{ file: "x.json", pointer: "/c" }];
  });
  const matrix = (files) => YAML.parse(files.get(".github/workflows/cascade-router.yml")).jobs.route.strategy.matrix;
  assert.deepEqual(matrix(declared), matrix(plain));
  const capture = (files) => /Capture the drift reports[\s\S]*?(?=\n {6}- name:)/.exec(files.get(".github/workflows/cascade-ai-lab-to-hub.md"))[0];
  assert.equal(capture(declared), capture(plain));
});

// ---- what is gone from the engine ---------------------------------------------------------------------------------------------------------------

test("the engine names no kind of command, no scope and no helper of an adopter: nothing of the old preflight classification is left", () => {
  const read = (...parts) => fs.readFileSync(path.join(ENGINE_ROOT, ...parts), "utf8");
  const preflight = read("src", "routing", "preflight.mjs");
  assert.deepEqual(Object.keys(preflightModule).sort(), ["PreflightError", "fillCheckout", "chooseSyncScope", "runPreflight", "declaredScript"].sort());
  assert.doesNotMatch(preflight, /\b(?:function\s+|(?:const|let|var)\s+)parse[\w$]*(?:Report|Result)\b/, "a command's declared classifier owns its report format");

  const scopeIds = (source) => [...source.matchAll(/(["'`])([a-z0-9]+(?:-[a-z0-9]+)*-(?:only|runs))\1/g)].map((match) => match[2]);
  assert.deepEqual(scopeIds('const scopes = ["pages-only", \'snapshots-runs\', `views-only`];'), ["pages-only", "snapshots-runs", "views-only"]);
  assert.deepEqual(scopeIds('const description = "read only when requested";'), []);
  // These are engine literals, not sync scopes: a gh-aw detection mode and a CLI option.
  const nonScopes = new Map([
    ["src/reconcile.mjs", new Set(["status-only"])],
    ["src/drift/previous-watch-index.mjs", new Set(["max-runs"])],
  ]);
  const walk = (relative) => {
    for (const entry of fs.readdirSync(path.join(ENGINE_ROOT, relative), { withFileTypes: true })) {
      const file = `${relative}/${entry.name}`;
      if (entry.isDirectory()) walk(file);
      else if (entry.isFile()) {
        const scopes = scopeIds(read(file)).filter((id) => !nonScopes.get(file)?.has(id));
        assert.deepEqual(scopes, [], `${file} must read scope ids from its caller, not embed adopter data`);
      }
    }
  };
  walk("src");
  walk("bin");
});
