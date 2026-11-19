// tools/run-each.mjs runs every test file in a process of its own. --tmp-root gives each file its own empty TEMP, TMP and TMPDIR under a directory, and reports what a file
// left in it after the run, so that a test that does not clean up after itself (or a child that ignores TMPDIR) is found by name; --fail-on-leak makes that a failure.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { engineAbs } from "./helpers/preset.mjs";

const RUN_EACH = engineAbs("tools", "run-each.mjs");

function tmpDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sdlc-run-each-test-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** Four tiny test files: one that cleans up, one that leaves a directory in its temp dir, one that fails, and one that looks at the variables that name the temp dir. */
function fixtures(dir) {
  const write = (name, body) => {
    fs.writeFileSync(path.join(dir, name), `import fs from "node:fs";\nimport os from "node:os";\nimport path from "node:path";\nimport test from "node:test";\n${body}\n`);
    return path.join(dir, name);
  };
  return {
    clean: write("clean.test.mjs", 'test("cleans up", () => { const made = fs.mkdtempSync(path.join(os.tmpdir(), "sdlc-fixture-")); fs.rmSync(made, { recursive: true }); });'),
    leaky: write("leaky.test.mjs", 'test("leaves a directory", () => { fs.mkdtempSync(path.join(os.tmpdir(), "sdlc-leaked-")); });'),
    failing: write("failing.test.mjs", 'test("fails", () => { throw new Error("on purpose"); });'),
    variables: write("variables.test.mjs", 'import assert from "node:assert/strict";\ntest("the three variables and os.tmpdir() name one directory", () => { const { TEMP, TMP, TMPDIR } = process.env; assert.ok(TEMP && TMP && TMPDIR); assert.equal(TMP, TEMP); assert.equal(TMPDIR, TEMP); assert.equal(path.resolve(os.tmpdir()), path.resolve(TEMP)); assert.deepEqual(fs.readdirSync(TEMP), []); });'),
  };
}

function runEach(args, env = {}) {
  const outcome = spawnSync(process.execPath, [RUN_EACH, ...args], { encoding: "utf8", windowsHide: true, env: { ...process.env, ...env }, timeout: 120000 });
  return { code: outcome.status, stdout: outcome.stdout, stderr: outcome.stderr };
}

test("a file that cleans up after itself passes without a word about its temp dir, and each file gets a temp dir of its own, named by all three variables", (t) => {
  const { clean, leaky, variables } = fixtures(tmpDir(t));
  const root = path.join(tmpDir(t), "tmp-root");
  const run = runEach(["--tmp-root", root, "--concurrency", "3", clean, leaky, variables]);
  assert.equal(run.code, 0, run.stdout + run.stderr);
  assert.match(run.stdout, /PASS .*clean\.test\.mjs  \(1 pass\)\n/);
  assert.match(run.stdout, /PASS .*variables\.test\.mjs  \(1 pass\)\n/, "TEMP, TMP and TMPDIR agree, and the temp dir starts empty");
  assert.doesNotMatch(run.stdout, /clean\.test\.mjs.*leaked/);
  assert.equal(fs.readdirSync(root).length, 3, "one temp dir for each file");
});

test("a file that leaves a directory behind is named, with what it left, and still passes unless --fail-on-leak is given", (t) => {
  const { leaky } = fixtures(tmpDir(t));
  const root = path.join(tmpDir(t), "tmp-root");
  const run = runEach(["--tmp-root", root, leaky]);
  assert.equal(run.code, 0, "a leak is reported, not a failure, by default");
  assert.match(run.stdout, /PASS .*leaky\.test\.mjs  \(1 pass\)  leaked 1: sdlc-leaked-\w+/);
  assert.match(run.stdout, /1 file\(s\) left something in their temp dir/);
  const [leftDir] = fs.readdirSync(root);
  assert.deepEqual(fs.readdirSync(path.join(root, leftDir)).map((name) => name.replace(/\w+$/, "")), ["sdlc-leaked-"], "the leftover is in the file's own temp dir, not in the system's");
});

test("--fail-on-leak turns a leftover into a failure of the run, and a failing file is a failure either way", (t) => {
  const { clean, leaky, failing } = fixtures(tmpDir(t));
  const leak = runEach(["--tmp-root", path.join(tmpDir(t), "a"), "--fail-on-leak", leaky]);
  assert.equal(leak.code, 1);
  assert.match(leak.stdout, /^LEAK +[\d.]+s .*leaky\.test\.mjs/m);
  assert.equal(runEach(["--tmp-root", path.join(tmpDir(t), "b"), "--fail-on-leak", clean]).code, 0);
  const failed = runEach(["--tmp-root", path.join(tmpDir(t), "c"), failing]);
  assert.equal(failed.code, 1);
  assert.match(failed.stdout, /^FAIL /m);
});

test("the report names what each file left, and a temp dir that is not empty is refused, because a count over it would mean nothing", (t) => {
  const { clean, leaky } = fixtures(tmpDir(t));
  const base = tmpDir(t);
  const report = path.join(base, "report.json");
  assert.equal(runEach(["--tmp-root", path.join(base, "root"), "--report", report, clean, leaky]).code, 0);
  const { files } = JSON.parse(fs.readFileSync(report, "utf8"));
  assert.deepEqual(files.map((entry) => [path.basename(entry.file), entry.leaked.length]).sort(), [["clean.test.mjs", 0], ["leaky.test.mjs", 1]]);
  const again = runEach(["--tmp-root", path.join(base, "root"), clean, leaky]);
  assert.equal(again.code, 2, "the temp dir of the leaky file still holds what it left");
  assert.match(again.stderr, /is not empty/);
});

test("without --tmp-root nothing changes: the files run in the environment they are given, and nothing is reported about leaks", (t) => {
  const { clean } = fixtures(tmpDir(t));
  const own = tmpDir(t);
  const run = runEach([clean], { TEMP: own, TMP: own, TMPDIR: own });
  assert.equal(run.code, 0, run.stdout + run.stderr);
  assert.doesNotMatch(run.stdout, /leaked|left something/);
  const guarded = runEach(["--fail-on-leak", clean]);
  assert.equal(guarded.code, 2, "--fail-on-leak counts the leftovers of the temp dir that --tmp-root gives each file");
  assert.match(guarded.stderr, /--fail-on-leak needs --tmp-root/);
});
