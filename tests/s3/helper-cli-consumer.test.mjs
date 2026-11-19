// The router as a consumer of a helper CLI that an edge's preflight command runs (SPEC-03 AC40, AC21, AC28): a stub CLI that emits each of its exit codes, run as a
// real process by a real bash from the workspace of the router, as the edge's preflight command names it. What decides is the exit code: 0 is no drift, 1 is drift,
// and anything else is a failure of the preflight that writes nothing. The router does not read what the helper prints (the helper guarantees that its output and
// its exit code agree); a check that needs its output read names a classifier, which runs here as a real process too, with the contract of its variables.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createStubBin, findBash, hostEnvironment } from "./helpers/git-world.mjs";
import { routerWorld } from "./helpers/harness.mjs";
import { sha, state } from "./helpers/fixtures.mjs";
import { CHANGED_REPORT, CLEAN_REPORT, DRIFT, HELPER_COMMAND, helperScript, IN_SYNC, nativePath, preflightEdge, REPORT_COMMAND, samePath } from "./helpers/preflight-world.mjs";
import { fixture } from "./helpers/fixtures.mjs";

const bash = findBash();

/**
 * The router with the stub helper (scripts/check-drift.mjs) and the stub classifier (scripts/classify.mjs) in its workspace and a stub npm; the checkouts are
 * directories (no git: this file is about the commands).
 * @param {object} drift what the stub helper does (helperScript)
 * @param {object} [options]
 * @param {object} [options.classifier] what the stub classifier answers ({ code } or { codes } by check index, { stderr })
 * @param {object[]} [options.npm] the rules of the stub npm
 * @param {object} [options.edge] overrides of the edge
 */
function consumer(drift, { classifier = { code: 0 }, npm, edge: edgeOverrides = {} } = {}) {
  const edge = preflightEdge(edgeOverrides);
  const bin = createStubBin({ npm: { rules: npm ?? [{ match: "^ci", code: 0 }, { match: "^run check:inputs", code: 0, stdout: CLEAN_REPORT }] } });
  const runnerTemp = fs.mkdtempSync(path.join(os.tmpdir(), "sdlc-s3-consumer-"));
  const w = routerWorld({ edge, state: state({}, edge), upstream: { head: sha("h2") }, env: { ...hostEnvironment(), PATH: bin.path(), RUNNER_TEMP: runnerTemp } });
  const scripts = path.join(w.workspace.dir, "scripts");
  fs.mkdirSync(scripts, { recursive: true });
  fs.copyFileSync(fixture("helpers", "check-drift.stub.mjs"), path.join(scripts, "check-drift.mjs"));
  fs.writeFileSync(path.join(scripts, "check-drift.stub.json"), JSON.stringify(helperScript(drift)));
  fs.copyFileSync(fixture("helpers", "classify.stub.mjs"), path.join(scripts, "classify.mjs"));
  fs.writeFileSync(path.join(scripts, "classify.stub.json"), JSON.stringify(classifier));
  const log = (name) => () => {
    const file = path.join(scripts, name);
    return fs.existsSync(file) ? fs.readFileSync(file, "utf8").trimEnd().split("\n").filter(Boolean).map((line) => JSON.parse(line)) : [];
  };
  return {
    w,
    edge,
    scripts,
    calls: log("check-drift.log.jsonl"),
    classifierCalls: log("classify.log.jsonl"),
    leftovers: () => fs.readdirSync(runnerTemp),
    go: () => w.go({ bash, preflightDeps: { ensureCheckout: async ({ dir }) => fs.mkdirSync(dir, { recursive: true }) } }),
    cleanup() {
      w.cleanup();
      bin.cleanup();
      fs.rmSync(runnerTemp, { recursive: true, force: true });
    },
  };
}

test("AC40 exit 0 is no drift: the preflight is a noop and the helper was run once, without --accept", async (t) => {
  const c = consumer({ code: 0, stdout: IN_SYNC });
  t.after(() => c.cleanup());
  const result = await c.go();
  assert.equal(result.code, 0, `${result.stderr}\n${result.stdout}`);
  assert.equal(c.w.decisions()[0].action, "noop-no-material-drift");
  assert.equal(c.w.stub.world.dispatches.length, 0);
  assert.equal(c.calls().length, 1);
  const [call] = c.calls();
  assert.deepEqual(call.args.filter((_, index) => index % 2 === 0), ["--downstream", "--upstream", "--commit"], "the three options of the contract, in the order of the edge's command");
  assert.equal(call.args.includes("--accept"), false);
  assert.equal(call.args[5], sha("h2"), "--commit is the target");
  assert.ok(samePath(call.args[1], path.join(c.w.workspace.dir, "hub")), "--downstream is the checkout of the downstream");
  assert.ok(samePath(call.args[3], path.join(c.w.workspace.dir, "upstream", "content")), "--upstream is the checkout of the upstream, in place of <checkout>");
  assert.ok(samePath(call.upstreamDir, call.args[3]), "and it is the directory that UPSTREAM_DIR names");
});

test("AC40 exit 1 is drift: the cascade is dispatched with the scope that the check declares", async (t) => {
  const c = consumer({ code: 1, stdout: DRIFT });
  t.after(() => c.cleanup());
  const result = await c.go();
  assert.equal(result.code, 0, `${result.stderr}\n${result.stdout}`);
  assert.equal(c.w.decisions()[0].action, "dispatch-ai-adaptation");
  assert.equal(c.w.stub.world.dispatches[0].body.inputs.sync_scope, "app-only");
  assert.equal(c.w.state().inFlightTargetSha, sha("h2"));
});

test("AC40 AC28 exit 2 is a failure of the preflight: nothing is written, nothing is dispatched, and one issue says why", async (t) => {
  const c = consumer({ code: 2, stdout: "", stderr: "fatal: cannot read the sources\n" });
  t.after(() => c.cleanup());
  const before = c.w.stub.variables.get(c.w.edge.stateVariable);
  const result = await c.go();
  assert.equal(result.code, 1);
  assert.match(result.stderr, /check-drift\.mjs.* exited with 2: fatal: cannot read the sources/);
  assert.equal(c.w.patches().length, 0);
  assert.equal(c.w.stub.variables.get(c.w.edge.stateVariable), before);
  assert.equal(c.w.stub.world.dispatches.length, 0);
  assert.equal(c.w.stub.issues.length, 1);
  assert.match(c.w.stub.issues[0].body, /fatal: cannot read the sources/);
});

test("AC40 the router reads the exit code of the helper and not what it prints: the helper's output and exit code agree by its own contract", async (t) => {
  for (const [label, drift, action] of [
    ["not JSON, exit 0", { code: 0, stdout: "all good\n" }, "noop-no-material-drift"],
    ["no output, exit 0", { code: 0, stdout: "" }, "noop-no-material-drift"],
    ["a result that says drift, exit 0", { code: 0, stdout: DRIFT }, "noop-no-material-drift"],
    ["a result that says in-sync, exit 1", { code: 1, stdout: IN_SYNC }, "dispatch-ai-adaptation"],
  ]) {
    const c = consumer(drift);
    t.after(() => c.cleanup());
    const result = await c.go();
    assert.equal(result.code, 0, `${label}: ${result.stderr}`);
    assert.equal(c.w.decisions()[0].action, action, label);
  }
  for (const [label, drift] of [
    ["an exit code of nobody's contract", { code: 3, stdout: IN_SYNC }],
    ["the exit code of an interrupted command", { code: 130, stdout: "" }],
  ]) {
    const c = consumer(drift);
    t.after(() => c.cleanup());
    const result = await c.go();
    assert.equal(result.code, 1, label);
    assert.equal(c.w.patches().length, 0, label);
    assert.equal(c.w.stub.world.dispatches.length, 0, label);
  }
});

test("AC40 a command that is not found is a failure, and no stand-in takes its place", async (t) => {
  const c = consumer(IN_SYNC, { edge: { preflightCommands: ["sdlc-no-such-helper --upstream <checkout>"], preflightChecks: [{ scope: "app-only" }] } });
  t.after(() => c.cleanup());
  const result = await c.go();
  assert.equal(result.code, 1);
  assert.match(result.stderr, /exited with 127/);
  assert.equal(c.w.patches().length, 0);
  assert.equal(c.w.stub.world.dispatches.length, 0);
  assert.deepEqual(c.calls(), [], "the stub helper was not run in its place");
});

test("AC40 a node script that is not there is a failure of the preflight and not a drift, although node itself exits 1 for the file", async (t) => {
  // node exits 1 for a file that is not there, and by the exit-code rule (design N.6 (a)) exit 1 is a drift: the router looks for the script before it runs
  // anything, so a manifest that names a helper that the orchestrator does not have fails the job instead of dispatching a cascade.
  const missing = consumer(IN_SYNC);
  t.after(() => missing.cleanup());
  const script = path.join(missing.scripts, "check-drift.mjs");
  fs.rmSync(script);
  const direct = spawnSync(process.execPath, [script], { encoding: "utf8", windowsHide: true });
  assert.equal(direct.status, 1, "the hazard is real: node exits 1 for a file that is not there");
  assert.match(direct.stderr, /Cannot find module/);
  const before = missing.w.stub.variables.get(missing.edge.stateVariable);
  const result = await missing.go();
  assert.equal(result.code, 1, `${result.stdout}\n${result.stderr}`);
  assert.match(result.stderr, /runs scripts\/check-drift\.mjs, which does not exist in the workspace/);
  assert.equal(missing.w.patches().length, 0);
  assert.equal(missing.w.stub.variables.get(missing.edge.stateVariable), before);
  assert.equal(missing.w.stub.world.dispatches.length, 0);
  assert.equal(missing.w.stub.issues.length, 1, "one issue says which script is missing");
  assert.match(missing.w.stub.issues[0].body, /scripts\/check-drift\.mjs/);
  assert.deepEqual(missing.calls(), [], "the stub was not run in its place");

  const unclassified = consumer(IN_SYNC, { npm: [{ match: "^ci", code: 0 }, { match: "^run check:inputs", code: 1, stdout: CHANGED_REPORT }] });
  t.after(() => unclassified.cleanup());
  fs.rmSync(path.join(unclassified.scripts, "classify.mjs"));
  const second = await unclassified.go();
  assert.equal(second.code, 1, "a classifier that is not there fails the preflight too");
  assert.match(second.stderr, /the preflight classifier .*classify\.mjs.* runs scripts\/classify\.mjs, which does not exist in the workspace/);
  assert.equal(unclassified.w.stub.world.dispatches.length, 0);
  assert.deepEqual(unclassified.calls(), []);
});

test("AC21 a classifier is a real process: it is handed the contract of its variables and the two streams of the command in files, and the files are gone afterwards", async (t) => {
  const c = consumer({ code: 0, stdout: IN_SYNC }, { npm: [{ match: "^ci", code: 0 }, { match: "^run check:inputs", code: 1, stdout: CHANGED_REPORT, stderr: "1 input changed\n" }], classifier: { codes: [1] } });
  t.after(() => c.cleanup());
  const result = await c.go();
  assert.equal(result.code, 0, `${result.stderr}\n${result.stdout}`);
  assert.equal(c.w.decisions()[0].action, "dispatch-ai-adaptation");
  assert.equal(c.w.stub.world.dispatches[0].body.inputs.sync_scope, "docs-only", "only the report drifted (its classifier said 1) and the helper said no drift, so the scope is the report's");
  assert.equal(c.classifierCalls().length, 1, "only the check that names a classifier has one");
  const [call] = c.classifierCalls();
  assert.equal(call.index, "0");
  assert.equal(call.command, REPORT_COMMAND, "the command as the manifest declares it");
  assert.equal(call.exitCode, "1", "the exit code of the command that was judged");
  assert.equal(call.stdout, CHANGED_REPORT, "the standard output of the command, as the classifier reads it from its file");
  assert.equal(call.stderr, "1 input changed\n");
  assert.equal(call.targetSha, sha("h2"));
  assert.deepEqual(call.secrets, [], "the classifier runs with the scrubbed environment of the check: no App credential reaches it");
  assert.ok(samePath(nativePath(call.stdoutFile).replace(/[^/]+$/, ""), nativePath(call.stderrFile).replace(/[^/]+$/, "")), "both files are in one directory");
  assert.equal(fs.existsSync(nativePath(call.stdoutFile)), false, "the file is removed when the preflight ends");
  assert.equal(fs.existsSync(nativePath(call.stderrFile)), false);
});

test("AC21 the command of the edge is the one in the contract: the helper's command is HELPER_COMMAND and nothing in it is the engine's", () => {
  assert.match(HELPER_COMMAND, /scripts\/check-drift\.mjs/);
  assert.equal(HELPER_COMMAND.includes("--accept"), false);
});
