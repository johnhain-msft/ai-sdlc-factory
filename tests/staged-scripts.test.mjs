// The scripts that the post-step validator runs from are staged read-only before the agent starts, and the project says which ones (design section E4). prepare-run
// used to stage every src/validate-*.mjs of the engine and everything below src/drift/lib/; the engine now has no validator of its own, so a project declares
// `driftAudit.stagedScripts` (workspace-relative .mjs paths), and the renderer hands them to prepare-run together with the factory directory. The stage mirrors the
// workspace, so one relative path means the same thing in the stage and in the workspace:
//
//   ${RUNNER_TEMP}/gh-aw/sdlc-validator/
//     scripts/validate-example.mjs                        <- <workspace>/scripts/validate-example.mjs
//     <factory-dir>/src/drift/lib/**                      <- the factory package that is running prepare-run
//     <factory-dir>/package.json                          <- the same package
//
// Four parts: the schema, what the renderer emits, the staging itself, and prepare-run as a command.

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { run as prepare, stageValidator } from "../src/drift/prepare-run.mjs";
import { VALIDATOR_STAGE_DIRECTORY } from "../src/drift/lib/cli.mjs";
import { renderFleet } from "../src/reconcile.mjs";
import { frontmatterOf, named } from "./helpers/rendered.mjs";
import { createWorkspace, referenceRequest } from "./helpers/mini-fleet.mjs";
import { abs, forceRemove, listTree, tempDir } from "./s2/helpers/fixtures.mjs";
import { createRepo } from "./s2/helpers/git-fixture.mjs";
import { invoke, isUnder, recordingFs } from "./s2/helpers/run-script.mjs";
import { cleanEnv } from "./s2/helpers/stub-server.mjs";

const VALIDATOR = "scripts/validate-example.mjs";
const STEP = "Prepare run context";
const projectOf = (manifest, key) => manifest.projects.find((project) => project.projectKey === key);
const prepareStep = (files, id) => named(frontmatterOf(files.get(`.github/workflows/${id}.md`))["pre-agent-steps"], STEP);

function render(t, { mutate } = {}) {
  const work = createWorkspace(t, { mutate, files: { "package.json": JSON.stringify({ name: "example-orchestrator", dependencies: { "ai-sdlc-factory": "github:example-org/ai-sdlc-factory#v0.1.0" } }) } });
  const result = renderFleet(referenceRequest(), { cwd: work.dir });
  assert.equal(result.ok, true, JSON.stringify(result.result));
  return result.files;
}

function failures(t, mutate) {
  const work = createWorkspace(t, { mutate });
  const result = renderFleet(referenceRequest(), { cwd: work.dir });
  assert.equal(result.ok, false, "the render was expected to be refused");
  return result.result.validationResults.flatMap((entry) => entry.errors);
}

// ---- the schema ------------------------------------------------------------------------------------------------------------------------------

test("stagedScripts: a list of workspace-relative .mjs paths, each once, and none that a shell or the stage could misread", (t) => {
  const accepted = [[], [VALIDATOR], [VALIDATOR, "scripts/lib/check.mjs"], ["a.mjs"], ["tools/ci/v-1.2_x@y.mjs"]];
  for (const list of accepted) render(t, { mutate: (manifest) => (projectOf(manifest, "docs-site").driftAudit.stagedScripts = list) });
  const refused = [
    ["a duplicate", [VALIDATOR, VALIDATOR]],
    ["not an .mjs file", ["scripts/validate.js"]],
    ["only a suffix", [".mjs"]],
    ["an absolute path", ["/scripts/validate.mjs"]],
    ["a drive path", ["C:/scripts/validate.mjs"]],
    ["a parent segment", ["scripts/../validate.mjs"]],
    ["a leading parent segment", ["../validate.mjs"]],
    ["a current-directory segment", ["./scripts/validate.mjs"]],
    ["an empty segment", ["scripts//validate.mjs"]],
    ["a comma, which separates the list on the command line", ["scripts/a,b.mjs"]],
    ["a space", ["scripts/my validate.mjs"]],
    ["a backslash", ["scripts\\validate.mjs"]],
    ["a leading dash", ["-validate.mjs"]],
    ["a shell metacharacter", ["scripts/$(x).mjs"]],
    ["an expression opener, which the schema keeps out of a path before any other rule sees it", ["scripts/${{ github.actor }}.mjs"]],
    ["an empty string", [""]],
    ["a non-string", [7]],
    ["not a list", VALIDATOR],
  ];
  for (const [label, list] of refused) {
    const errors = failures(t, (manifest) => (projectOf(manifest, "docs-site").driftAudit.stagedScripts = list));
    assert.ok(errors.some((error) => error.startsWith("schema-validation: ") && error.includes("stagedScripts")), `${label}: ${errors.join(" | ")}`);
  }
});

// ---- the renderer ----------------------------------------------------------------------------------------------------------------------------

const LEGACY_DRIFT = 'node "$GITHUB_WORKSPACE/src/drift/prepare-run.mjs" --out /tmp/gh-aw/agent --target-repo "$TARGET_REPO_INPUT" --correlation-id "$CORRELATION_ID" --extra-instructions "$EXTRA_INSTRUCTIONS" --dry-run "$DRY_RUN"';
const LEGACY_IMPLEMENT = 'node "$GITHUB_WORKSPACE/src/drift/prepare-run.mjs" --out /tmp/gh-aw/agent --correlation-id "$CORRELATION_ID" --dry-run "$DRY_RUN"';

test("no stagedScripts, or an empty list: the Prepare run context step is what it always was, and nothing is staged", (t) => {
  for (const mutate of [undefined, (manifest) => (projectOf(manifest, "docs-site").driftAudit.stagedScripts = [])]) {
    const files = render(t, { mutate });
    for (const id of ["drift-docs-site", "drift-lab-content"]) assert.equal(prepareStep(files, id).run, LEGACY_DRIFT, id);
    for (const id of ["implement-docs-site", "implement-lab-content"]) assert.equal(prepareStep(files, id).run, LEGACY_IMPLEMENT, id);
  }
});

test("a project that declares stagedScripts passes the factory directory and the list to the Prepare run context step of its drift and implement workflows, and no other does", (t) => {
  const files = render(t, { mutate: (manifest) => (projectOf(manifest, "docs-site").driftAudit.stagedScripts = [VALIDATOR, "scripts/lib/check.mjs"]) });
  assert.equal(prepareStep(files, "drift-docs-site").run, `${LEGACY_DRIFT} --factory-dir . --stage-scripts ${VALIDATOR},scripts/lib/check.mjs`);
  assert.equal(prepareStep(files, "implement-docs-site").run, `${LEGACY_IMPLEMENT} --factory-dir . --stage-scripts ${VALIDATOR},scripts/lib/check.mjs`);
  assert.equal(prepareStep(files, "drift-lab-content").run, LEGACY_DRIFT, "a project that declares none stages none");
  assert.equal(prepareStep(files, "implement-lab-content").run, LEGACY_IMPLEMENT);
});

test("the factory directory that is passed is the one of the factory block: installed under node_modules, in a directory of the workspace, or the workspace itself", (t) => {
  const stage = (manifest) => (projectOf(manifest, "lab-content").driftAudit.stagedScripts = [VALIDATOR]);
  const installed = render(t, { mutate: (manifest) => (stage(manifest), (manifest.factory = { package: "ai-sdlc-factory" })) });
  assert.match(prepareStep(installed, "drift-lab-content").run, /^node "\$GITHUB_WORKSPACE\/node_modules\/ai-sdlc-factory\/src\/drift\/prepare-run\.mjs" .* --factory-dir node_modules\/ai-sdlc-factory --stage-scripts scripts\/validate-example\.mjs$/);
  const moved = render(t, { mutate: (manifest) => (stage(manifest), (manifest.factory = { package: "ai-sdlc-factory", dir: "./vendor//factory/" })) });
  assert.match(prepareStep(moved, "implement-lab-content").run, / --factory-dir vendor\/factory --stage-scripts scripts\/validate-example\.mjs$/, "the directory as the renderer normalizes it");
  const inWorkspace = render(t, { mutate: (manifest) => (stage(manifest), (manifest.factory = { package: "ai-sdlc-factory", dir: "." })) });
  assert.match(prepareStep(inWorkspace, "drift-lab-content").run, / --factory-dir \. --stage-scripts scripts\/validate-example\.mjs$/);
});

test("nothing else of a workflow changes with stagedScripts: the one step that stages is the one that differs", (t) => {
  const before = render(t);
  const after = render(t, { mutate: (manifest) => (projectOf(manifest, "docs-site").driftAudit.stagedScripts = [VALIDATOR]) });
  for (const [file, text] of before) {
    if (file === ".github/workflows/drift-docs-site.md" || file === ".github/workflows/implement-docs-site.md") continue;
    assert.equal(after.get(file), text, file);
  }
  for (const id of ["drift-docs-site", "implement-docs-site"]) {
    const a = frontmatterOf(before.get(`.github/workflows/${id}.md`));
    const b = frontmatterOf(after.get(`.github/workflows/${id}.md`));
    a["pre-agent-steps"].find((step) => step.name === STEP).run = "";
    b["pre-agent-steps"].find((step) => step.name === STEP).run = "";
    assert.deepEqual(b, a, id);
  }
});

// ---- the staging -----------------------------------------------------------------------------------------------------------------------------

const posixOnly = process.platform === "win32" ? "directory modes are not enforced on Windows" : false;
const entriesOf = (value) => Object.entries(value);

/** A workspace with instance scripts, a stand-in factory package, and a RUNNER_TEMP: nothing of the real engine, so the layout is checked on its own. */
function world(t, { scripts = { [VALIDATOR]: "export const ok = true;\n", "scripts/lib/check.mjs": "export const check = 1;\n" } } = {}) {
  const root = tempDir("sdlc-staged-");
  t.after(() => forceRemove(root));
  const write = (relative, text) => {
    const target = path.join(root, ...relative.split("/"));
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, text);
  };
  for (const [relative, text] of entriesOf(scripts)) write(`workspace/${relative}`, text);
  write("package/package.json", '{ "name": "stand-in-factory" }\n');
  write("package/src/drift/lib/a.mjs", "export const a = 1;\n");
  write("package/src/drift/lib/deeper/b.mjs", "export const b = 2;\n");
  write("package/src/drift/other.mjs", "export const notStaged = true;\n");
  const runnerTemp = path.join(root, "runner-temp");
  fs.mkdirSync(runnerTemp, { recursive: true });
  return {
    root,
    workspace: path.join(root, "workspace"),
    factoryRoot: path.join(root, "package"),
    runnerTemp,
    stage: path.join(runnerTemp, "gh-aw", VALIDATOR_STAGE_DIRECTORY),
    write,
    io: (extra = {}) => ({ env: { RUNNER_TEMP: runnerTemp }, fs, ...extra }),
  };
}

test("the stage mirrors the workspace: the declared scripts at their own paths, the factory's drift/lib and package.json under the factory directory, and nothing else", (t) => {
  const w = world(t);
  const result = stageValidator(w.io(), { workspace: w.workspace, factoryDir: "node_modules/ai-sdlc-factory", factoryRoot: w.factoryRoot, scripts: [VALIDATOR, "scripts/lib/check.mjs"] });
  assert.deepEqual(listTree(w.stage), [
    "node_modules/ai-sdlc-factory/package.json",
    "node_modules/ai-sdlc-factory/src/drift/lib/a.mjs",
    "node_modules/ai-sdlc-factory/src/drift/lib/deeper/b.mjs",
    "scripts/lib/check.mjs",
    VALIDATOR,
  ]);
  assert.deepEqual(result, { directory: w.stage, files: 5 });
  const same = (stagedPath, sourcePath) => assert.ok(fs.readFileSync(path.join(w.stage, ...stagedPath.split("/"))).equals(fs.readFileSync(sourcePath)), stagedPath);
  same(VALIDATOR, path.join(w.workspace, ...VALIDATOR.split("/")));
  same("node_modules/ai-sdlc-factory/src/drift/lib/deeper/b.mjs", path.join(w.factoryRoot, "src", "drift", "lib", "deeper", "b.mjs"));
  same("node_modules/ai-sdlc-factory/package.json", path.join(w.factoryRoot, "package.json"));
});

test("a factory directory of . puts the factory's files at the root of the stage, beside the scripts", (t) => {
  const w = world(t);
  stageValidator(w.io(), { workspace: w.workspace, factoryDir: ".", factoryRoot: w.factoryRoot, scripts: [VALIDATOR] });
  assert.deepEqual(listTree(w.stage), ["package.json", "scripts/validate-example.mjs", "src/drift/lib/a.mjs", "src/drift/lib/deeper/b.mjs"]);
});

test("without a list of scripts the stage holds the factory's files alone", (t) => {
  const w = world(t);
  stageValidator(w.io(), { workspace: w.workspace, factoryDir: "vendor/factory", factoryRoot: w.factoryRoot, scripts: [] });
  assert.deepEqual(listTree(w.stage), ["vendor/factory/package.json", "vendor/factory/src/drift/lib/a.mjs", "vendor/factory/src/drift/lib/deeper/b.mjs"]);
});

test("the factory package is the one that contains the running prepare-run, unless the caller names another", () => {
  const root = tempDir("sdlc-staged-default-");
  try {
    const runnerTemp = path.join(root, "runner-temp");
    const workspace = path.join(root, "workspace");
    fs.mkdirSync(runnerTemp, { recursive: true });
    fs.mkdirSync(workspace, { recursive: true });
    const result = stageValidator({ env: { RUNNER_TEMP: runnerTemp }, fs }, { workspace, factoryDir: "node_modules/ai-sdlc-factory", scripts: [] });
    const stage = path.join(runnerTemp, "gh-aw", VALIDATOR_STAGE_DIRECTORY, "node_modules", "ai-sdlc-factory");
    const expected = ["package.json", ...listTree(abs("src", "drift", "lib")).map((file) => `src/drift/lib/${file}`)].sort();
    assert.deepEqual(listTree(stage), expected);
    assert.equal(result.files, expected.length);
    for (const relative of expected) assert.ok(fs.readFileSync(path.join(stage, ...relative.split("/"))).equals(fs.readFileSync(abs(...relative.split("/")))), `${relative} is a copy of this package's own`);
    assert.ok(expected.length >= 4, "package.json and the modules of drift/lib");
  } finally {
    forceRemove(root);
  }
});

test("the staged files are read-only, so that nothing that runs as the agent's user can rewrite the copy that it is compared with", (t) => {
  const w = world(t);
  stageValidator(w.io(), { workspace: w.workspace, factoryDir: ".", factoryRoot: w.factoryRoot, scripts: [VALIDATOR] });
  if (process.getuid?.() !== 0) {
    assert.throws(() => fs.writeFileSync(path.join(w.stage, "scripts", "validate-example.mjs"), "process.exit(0);\n"), /EACCES|EPERM/);
    assert.throws(() => fs.writeFileSync(path.join(w.stage, "src", "drift", "lib", "a.mjs"), "export {};\n"), /EACCES|EPERM/);
  }
  for (const relative of listTree(w.stage)) assert.equal(fs.statSync(path.join(w.stage, ...relative.split("/"))).mode & 0o222, 0, `${relative} has no write bit`);
});

test("the staged directories are read-only too (POSIX)", { skip: posixOnly }, (t) => {
  const w = world(t);
  stageValidator(w.io(), { workspace: w.workspace, factoryDir: "node_modules/ai-sdlc-factory", factoryRoot: w.factoryRoot, scripts: [VALIDATOR] });
  for (const directory of ["", "scripts", "node_modules", "node_modules/ai-sdlc-factory", "node_modules/ai-sdlc-factory/src/drift/lib/deeper"]) {
    assert.equal(fs.statSync(path.join(w.stage, ...directory.split("/").filter(Boolean))).mode & 0o777, 0o555, directory || "(the stage)");
  }
});

test("a second run in the same RUNNER_TEMP replaces the stage, although it is read-only, and leaves no stale file of the earlier list", (t) => {
  const w = world(t);
  stageValidator(w.io(), { workspace: w.workspace, factoryDir: ".", factoryRoot: w.factoryRoot, scripts: [VALIDATOR, "scripts/lib/check.mjs"] });
  assert.ok(fs.existsSync(path.join(w.stage, "scripts", "lib", "check.mjs")));
  w.write("workspace/scripts/validate-example.mjs", "export const ok = 'changed';\n");
  stageValidator(w.io(), { workspace: w.workspace, factoryDir: ".", factoryRoot: w.factoryRoot, scripts: [VALIDATOR] });
  assert.deepEqual(listTree(w.stage), ["package.json", "scripts/validate-example.mjs", "src/drift/lib/a.mjs", "src/drift/lib/deeper/b.mjs"], "the script that is no longer listed is gone");
  assert.equal(fs.readFileSync(path.join(w.stage, "scripts", "validate-example.mjs"), "utf8"), "export const ok = 'changed';\n", "and the one that is listed is the current one");
});

test("outside Actions (no RUNNER_TEMP) there is nothing to stage the copy for", (t) => {
  const w = world(t);
  assert.equal(stageValidator({ env: {}, fs }, { workspace: w.workspace, factoryDir: ".", factoryRoot: w.factoryRoot, scripts: [VALIDATOR] }), null);
  assert.equal(fs.existsSync(w.stage), false);
});

test("a stage that cannot be built is refused whole: a missing script, a directory, a link, a bad path or a bad factory directory leave nothing staged", (t) => {
  const w = world(t);
  fs.mkdirSync(path.join(w.workspace, "scripts", "a-directory.mjs"), { recursive: true });
  const linkLike = new Proxy(fs, {
    get(target, property) {
      if (property === "lstatSync") {
        return (file, ...rest) => {
          const stat = target.lstatSync(file, ...rest);
          return /lib[\\/]check\.mjs$/.test(String(file)) ? { isFile: () => false, isDirectory: () => false, isSymbolicLink: () => true } : stat;
        };
      }
      const value = target[property];
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  const base = { workspace: w.workspace, factoryDir: ".", factoryRoot: w.factoryRoot };
  w.write("workspace/src/drift/lib/a.mjs", "export const shadow = true;\n");
  const emptyFactory = path.join(w.root, "empty-factory");
  fs.mkdirSync(emptyFactory, { recursive: true });
  const cases = [
    ["a script that is not there", w.io(), { ...base, scripts: ["scripts/missing.mjs"] }, /scripts\/missing\.mjs is not a file in the workspace/],
    ["a script at the path of a file of the factory, which it would shadow in the stage", w.io(), { ...base, scripts: ["src/drift/lib/a.mjs"] }, /src\/drift\/lib\/a\.mjs would be staged twice/],
    ["a script that is a directory", w.io(), { ...base, scripts: ["scripts/a-directory.mjs"] }, /scripts\/a-directory\.mjs is not a file in the workspace/],
    ["a script that is a link", w.io({ fs: linkLike }), { ...base, scripts: [VALIDATOR, "scripts/lib/check.mjs"] }, /scripts\/lib\/check\.mjs is not a file in the workspace/],
    ["a script outside the workspace", w.io(), { ...base, scripts: ["../outside.mjs"] }, /'\.\.\/outside\.mjs' .*'\.\.'/],
    ["a script that is not an .mjs file", w.io(), { ...base, scripts: ["scripts/validate.js"] }, /'scripts\/validate\.js' .*\.mjs/],
    ["a factory directory outside the workspace", w.io(), { ...base, factoryDir: "../factory", scripts: [] }, /factory directory '\.\.\/factory'/],
    ["a factory package without drift/lib", w.io(), { ...base, factoryRoot: emptyFactory, scripts: [] }, /drift[\\/]lib/],
    ["a factory package without package.json", w.io(), { ...base, factoryRoot: w.workspace, scripts: [] }, /package\.json is not a file of the factory package/],
  ];
  for (const [label, io, options, pattern] of cases) {
    assert.throws(() => stageValidator(io, options), (error) => /^the validator cannot be staged under /.test(error.message) && pattern.test(error.message), label);
    assert.equal(fs.existsSync(w.stage), false, `${label}: nothing is staged`);
  }
});

// ---- prepare-run as a command ----------------------------------------------------------------------------------------------------------------

const TARGET = "example-org/example-target";

/**
 * A job's workspace: instance scripts, a target checkout that is a git repository (unless `checkout` is false: a workspace that prepare-run could not read a
 * base commit from), a RUNNER_TEMP and the environment that the runner gives the first step.
 */
function job(t, scripts = { [VALIDATOR]: "export const ok = true;\n" }, { checkout: withCheckout = true } = {}) {
  const root = tempDir("sdlc-staged-job-");
  t.after(() => forceRemove(root));
  const workspace = path.join(root, "workspace");
  const runnerTemp = path.join(root, "runner-temp");
  fs.mkdirSync(runnerTemp, { recursive: true });
  for (const [relative, text] of entriesOf(scripts)) {
    const target = path.join(workspace, ...relative.split("/"));
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, text);
  }
  const checkout = withCheckout ? createRepo({ "README.md": "target\n" }, { dir: path.join(workspace, "example-target") }) : null;
  const stage = path.join(runnerTemp, "gh-aw", VALIDATOR_STAGE_DIRECTORY);
  const env = (extra = {}) => cleanEnv({ GITHUB_WORKSPACE: workspace, CONFIGURED_TARGET_REPO: TARGET, RUNNER_TEMP: runnerTemp, GITHUB_ENV: "", ...extra });
  return { root, workspace, runnerTemp, stage, env, checkout, out: (name = "agent") => path.join(root, name) };
}

test("prepare-run with --factory-dir and --stage-scripts stages the declared scripts and the factory's modules, says so, and writes nothing else", async (t) => {
  const run = job(t);
  const recorder = recordingFs();
  const envFile = path.join(run.root, "github-env");
  fs.writeFileSync(envFile, "");
  const result = await invoke(prepare, ["--out", run.out(), "--target-repo", TARGET, "--factory-dir", "node_modules/ai-sdlc-factory", "--stage-scripts", VALIDATOR], { env: run.env({ GITHUB_ENV: envFile }), cwd: run.root, fs: recorder.fs });
  assert.equal(result.code, 0, result.stderr);
  const staged = listTree(run.stage);
  assert.ok(staged.includes(VALIDATOR));
  assert.ok(staged.includes("node_modules/ai-sdlc-factory/package.json"));
  assert.ok(staged.some((file) => file.startsWith("node_modules/ai-sdlc-factory/src/drift/lib/")));
  assert.equal(staged.some((file) => /reconcile|prepare-run|dedupe|escalate|snapshot/.test(file)), false, "and nothing else of the engine is copied");
  assert.match(result.stdout, new RegExp(`${staged.length} validator files staged read-only under `));
  const elsewhere = recorder.writes.filter((written) => !isUnder(written, run.out()) && !isUnder(written, run.stage) && path.resolve(written) !== path.resolve(envFile) && !isUnder(written, abs("src")) && !isUnder(written, run.workspace) && path.resolve(written) !== abs("package.json"));
  assert.deepEqual(elsewhere, [], "no other path is written");
  assert.deepEqual(listTree(run.out()), ["run-context.json"], "the staged copy is not an artifact");
  assert.equal(run.checkout.status(), "", "the target checkout is as it was");
});

test("prepare-run without --factory-dir stages nothing, whatever RUNNER_TEMP is: a project that declares no stagedScripts has no stage directory", async (t) => {
  const run = job(t);
  const result = await invoke(prepare, ["--out", run.out(), "--target-repo", TARGET], { env: run.env(), cwd: run.root });
  assert.equal(result.code, 0, result.stderr);
  assert.equal(fs.existsSync(run.stage), false);
  assert.equal(fs.existsSync(path.join(run.runnerTemp, "gh-aw")), false);
  assert.doesNotMatch(result.stdout, /validator files staged/);
});

test("prepare-run outside Actions (no RUNNER_TEMP) stages nothing and does not fail for it", async (t) => {
  const run = job(t);
  const result = await invoke(prepare, ["--out", run.out(), "--target-repo", TARGET, "--factory-dir", ".", "--stage-scripts", VALIDATOR], { env: run.env({ RUNNER_TEMP: "" }), cwd: run.root });
  assert.equal(result.code, 0, result.stderr);
  assert.doesNotMatch(result.stdout, /validator files staged/);
});

test("prepare-run stops before the agent starts, with nothing under --out, when a declared script is not in the workspace", async (t) => {
  const run = job(t);
  const result = await invoke(prepare, ["--out", run.out("refused"), "--target-repo", TARGET, "--factory-dir", ".", "--stage-scripts", "scripts/missing.mjs"], { env: run.env(), cwd: run.root });
  assert.equal(result.code, 1);
  assert.match(result.stderr, /prepare-run: the validator cannot be staged under .*scripts\/missing\.mjs is not a file in the workspace/);
  assert.equal(fs.existsSync(run.out("refused")), false);
  assert.equal(fs.existsSync(run.stage), false);
});

test("prepare-run refuses what the schema would have refused, as a usage error, before it reads the checkout or writes anything", async (t) => {
  // the workspace has no checkout to read a base commit from: a validation that came after the checkout was read would exit 1 there, not 2
  const run = job(t, undefined, { checkout: false });
  const cases = [
    ["a list without a factory directory", ["--stage-scripts", VALIDATOR], /--stage-scripts needs --factory-dir/],
    ["an empty factory directory", ["--factory-dir", "", "--stage-scripts", VALIDATOR], /--factory-dir must name a directory/],
    ["a factory directory outside the workspace", ["--factory-dir", "../factory"], /--factory-dir '\.\.\/factory' .*'\.\.'/],
    ["an absolute factory directory", ["--factory-dir", "/opt/factory"], /--factory-dir '\/opt\/factory' .*absolute/],
    ["a script outside the workspace", ["--factory-dir", ".", "--stage-scripts", "../validate.mjs"], /--stage-scripts entry '\.\.\/validate\.mjs' .*'\.\.'/],
    ["a script that is not .mjs", ["--factory-dir", ".", "--stage-scripts", "scripts/validate.js"], /--stage-scripts entry 'scripts\/validate\.js' .*\.mjs/],
    ["an empty entry", ["--factory-dir", ".", "--stage-scripts", `${VALIDATOR},,scripts/x.mjs`], /--stage-scripts has an empty entry/],
    ["a repeated entry", ["--factory-dir", ".", "--stage-scripts", `${VALIDATOR},${VALIDATOR}`], /--stage-scripts lists '[^']+' twice/],
  ];
  for (const [label, flags, pattern] of cases) {
    const result = await invoke(prepare, ["--out", run.out("usage"), "--target-repo", TARGET, ...flags], { env: run.env(), cwd: run.root });
    assert.equal(result.code, 2, `${label}: ${result.stderr}`);
    assert.match(result.stderr, pattern, label);
    assert.equal(fs.existsSync(run.out("usage")), false, label);
    assert.equal(fs.existsSync(run.stage), false, label);
  }
});
