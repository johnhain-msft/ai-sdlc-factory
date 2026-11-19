// The router consumes a helper only through the command that an edge declares (SPEC-03 AC41, AC42, AC43, AC44, AC45, AC52). Its fixture is a stub, not an
// implementation of an adopter's helper. The router neither defines nor directly invokes the engine's immutable-gate helper; that belongs to the cascade.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fakePreflight } from "./helpers/fake-preflight.mjs";
import { routerWorld } from "./helpers/harness.mjs";
import { abs, fixture, presetEdges as presetEdgesOf, REPO_ROOT, sha, state } from "./helpers/fixtures.mjs";
import { CHANGED_REPORT, IN_SYNC, preflightEdge, STAND_IN_SCRIPTS } from "./helpers/preflight-world.mjs";

const VERIFY = "verify-immutable-gates";
const HELPER = "check-drift";

const scriptFiles = () => [abs("src", "route-upstream.mjs"), abs("src", "update-poll-state.mjs"), ...fs.readdirSync(abs("src", "routing")).map((name) => abs("src", "routing", name))];
const workflowFiles = () => [
  abs(".github", "workflows", "cascade-router.yml"),
  ...presetEdgesOf().filter((entry) => entry.mode === "mechanical").flatMap((entry) => [abs(".github", "workflows", `cascade-mechanical-${entry.edgeId}.md`), abs(".github", "workflows", `cascade-mechanical-${entry.edgeId}.lock.yml`)]),
];
const rel = (file) => path.relative(REPO_ROOT, file).replace(/\\/g, "/");
const code = (file) =>
  fs
    .readFileSync(file, "utf8")
    .split("\n")
    .filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line))
    .join("\n");
const readPrompt = (edgeId) => fs.readFileSync(abs(".github", "workflows", `cascade-mechanical-${edgeId}.md`), "utf8").split(/\r?\n---\r?\n/)[1];

test("AC41 AC42 the scripts, their modules, the router and the mechanical workflows never invoke the immutable-gate helper by name", () => {
  for (const file of [...scriptFiles(), ...workflowFiles()]) {
    const text = fs.readFileSync(file, "utf8");
    assert.equal(text.includes(VERIFY), false, `${rel(file)} names ${VERIFY}`);
  }
});

test("AC52 no router script or test defines a helper: helper files and option parsing stay outside the routing implementation", () => {
  const owned = [...scriptFiles(), ...fs.readdirSync(abs("tests", "s3")).filter((name) => name.endsWith(".test.mjs")).map((name) => abs("tests", "s3", name))];
  for (const file of owned) assert.equal(new RegExp(`${VERIFY}|${HELPER}`).test(path.basename(file)), false, rel(file));
  // helper-specific options are never parsed by a script of the router
  for (const file of scriptFiles()) {
    const text = code(file);
    for (const option of ["--new-sha", "--accept", "--downstream", "--frozen-intrinsics"]) assert.equal(text.includes(option), false, `${rel(file)} handles ${option}`);
  }
  // the one stand-in that exists is a fixture of the tests, named as such, and says what it is
  const stub = abs("tests", "s3", "fixtures", "helpers", "check-drift.stub.mjs");
  assert.ok(fs.existsSync(stub));
  assert.match(fs.readFileSync(stub, "utf8"), /hermetic stand-in/);
  assert.match(fs.readFileSync(stub, "utf8"), /never substitutes this file for a missing one/);
});

test("AC41 AC42 the router runs the edge's own commands and no other: for an edge without a preflight no command is run, and for every edge what is run is the edge's text", async (t) => {
  const quiet = routerWorld();
  t.after(() => quiet.cleanup());
  const none = fakePreflight([]);
  assert.equal((await quiet.go({ preflightDeps: none.deps })).code, 0);
  assert.deepEqual(none.calls, [], "an edge that declares no preflight runs nothing");

  const content = preflightEdge();
  const w = routerWorld({ edge: content, state: state({}, content), upstream: { head: sha("h2") }, workspaceFiles: STAND_IN_SCRIPTS });
  t.after(() => w.cleanup());
  const fake = fakePreflight([{ match: /check:inputs/, code: 1, stdout: CHANGED_REPORT }, { match: /check-drift/, code: 0, stdout: `${JSON.stringify(IN_SYNC)}\n` }, { match: /classify\.mjs/, code: 1 }]);
  assert.equal((await w.go({ preflightDeps: fake.deps })).code, 0);
  const expected = [...content.preflightCommands, ...content.preflightChecks.flatMap((check) => check.classifier ? [check.classifier] : [])].map((command) => command.split("<checkout>").join('"$UPSTREAM_DIR"'));
  const ran = fake.scripts().filter((script) => !script.startsWith("npm ci"));
  assert.deepEqual(ran, expected, "exactly the edge's commands, with the checkout bound");
  for (const script of fake.scripts()) {
    assert.equal(script.includes(VERIFY), false);
    assert.equal(script.includes("--accept"), false, "the router never accepts a revision on behalf of a helper");
  }
  assert.equal(w.stub.world.dispatches[0].body.inputs.sync_scope, "docs-only");
  assert.equal(w.state().inFlightTargetSha, sha("h2"));
});

test("AC64 the importer is a black box: no source or test of S3 asserts, copies or depends on its sanitisation allowlist, its link rewriting, its Markdown parsing or its heading ids", () => {
  // the names of the importer's own libraries and options, assembled so that this file does not contain them
  const names = [["sanitize", "-html"], ["Markdown", "It"], ["Github", "Slugger"], ["transform", "Tags"], ["allowed", "Schemes"], ["wrapDiagram", "Cards"], ["rewrite", "Link"]].map((parts) => parts.join(""));
  const found = [];
  const walk = (directory) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const full = path.join(directory, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (/\.(mjs|json|md)$/.test(entry.name) && !full.endsWith("helper-cli-boundary.test.mjs")) found.push(full);
    }
  };
  walk(abs("src", "routing"));
  walk(abs("tests", "s3"));
  found.push(abs("src", "route-upstream.mjs"), abs("src", "update-poll-state.mjs"));
  for (const file of found) {
    const text = fs.readFileSync(file, "utf8");
    for (const name of names) assert.equal(text.includes(name), false, `${rel(file)} names ${name}`);
  }
  // the only thing that S3 knows about the importer is one positional argument: the edge's command, with the checkout bound
  const mechanical = presetEdgesOf().find((entry) => entry.mode === "mechanical");
  const workflow = readPrompt(mechanical.edgeId);
  for (const command of mechanical.importCommands) assert.ok(workflow.includes(command.replaceAll("<checkout>", '"$UPSTREAM_DIR"')), "the prompt passes the checkout to the declared importer without interpreting it");
});

test("AC43 AC44 AC45 S3 asserts only the boundary of the checks that SPEC-04 owns: no source of S3 parses test files, names their blocks, or checks the rules that those checks verify", () => {
  const checks = [/\b(?:describe|it)\(\s*["'`]/, /\.skip\b/, /\.only\b/, /\bvi\.mock\b/, /tests\/support\/terms/, /content\/rules/];
  for (const file of scriptFiles()) {
    const text = code(file);
    for (const pattern of checks) assert.equal(pattern.test(text), false, `${rel(file)} matches ${pattern}`);
  }
  assert.equal(fs.existsSync(fixture("helpers", "check-drift.stub.mjs")), true);
});
