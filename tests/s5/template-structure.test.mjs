// The package layout. What a consumer installs is what `files` lets through, so the tests below look at the tarball that npm would make (`npm pack --dry-run`),
// not only at package.json: the allowlist, the files the commands need, the scripts that must not exist, the lockfile that must name the public registry only, the
// license, and the CI workflow that guards all of it (pinned actions, a read-only token, no secrets, no `pull_request_target`). The last part keeps what the
// commands have always promised: the central repository is read from the `origin` remote of the working copy that holds the manifest, never from a literal.
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import YAML from "yaml";
import { parseRemoteUrl, resolveCentralRepo } from "../../bin/lib/central-repo.mjs";
import { workspaceManifestPath } from "../../src/lib/manifest-location.mjs";
import { renderFleet } from "../../src/reconcile.mjs";
import { createWorkspace as createFleetWorkspace, referenceRequest } from "../helpers/mini-fleet.mjs";
import { REPO_ROOT, createWorkspace } from "./helpers/harness.mjs";

const read = (...parts) => fs.readFileSync(path.join(REPO_ROOT, ...parts), "utf8");
const exists = (...parts) => fs.existsSync(path.join(REPO_ROOT, ...parts));
const pkg = JSON.parse(read("package.json"));
const lock = JSON.parse(read("package-lock.json"));
const have = (command, args) => spawnSync(command, args, { encoding: "utf8" }).status === 0;

// ---------------------------------------------------------------------------------------------------------------------
// Files of the repository
// ---------------------------------------------------------------------------------------------------------------------

const ARTIFACTS = [
  "README.md",
  "CHANGELOG.md",
  "SECURITY.md",
  "LICENSE",
  "aw.yml",
  "package.json",
  "package-lock.json",
  ".gitignore",
  ".gitattributes",
  ".github/workflows/ci.yml",
  "docs/architecture.md",
  "docs/manifest.md",
  "docs/private-engine.md",
  "docs/api.md",
  "payload/workflows/sdlc-onboard.md",
  "bin/sdlc-bootstrap.mjs",
  "bin/sdlc-onboard.mjs",
  "bin/sdlc-reconcile.mjs",
  "bin/lib",
  "schemas/sdlc.schema.json",
  "schemas/bootstrap-summary-report.schema.json",
  "src/reconcile.mjs",
  "src/script-kit.mjs",
  "src/drift/lib/index.mjs",
  "tools/leak-guard/scan.mjs",
  "tests/s5",
];

for (const artifact of ARTIFACTS) {
  test(`${artifact} exists`, () => {
    assert.ok(exists(...artifact.split("/")));
  });
}

test("the repository keeps node_modules and tarballs out of git, and writes every text file with LF", () => {
  const ignore = read(".gitignore").split("\n");
  assert.ok(ignore.includes("node_modules/"));
  assert.ok(ignore.includes("*.tgz"));
  assert.match(read(".gitattributes"), /^\* text=auto eol=lf$/m);
});

test("the license is MIT and its holder is the contributors of the project", () => {
  const license = read("LICENSE");
  assert.match(license, /^MIT License\n\nCopyright \(c\) \d{4} ai-sdlc-factory contributors\n/);
  assert.match(license, /Permission is hereby granted, free of charge, to any person obtaining a copy/);
  assert.match(license, /THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND/);
  assert.equal(pkg.license, "MIT");
});

// ---------------------------------------------------------------------------------------------------------------------
// package.json
// ---------------------------------------------------------------------------------------------------------------------

const ALLOWLIST = ["src", "bin", "schemas", "prompts", "LICENSE", "README.md", "CHANGELOG.md"];
// npm runs these when the package is installed from a git dependency, or when it is packed: none may exist (a dependency install in the clone would run them)
const LIFECYCLE = ["preinstall", "install", "postinstall", "prepublish", "preprepare", "prepare", "postprepare", "prepack", "postpack", "build"];

test("package.json is a module named ai-sdlc-factory, for Node.js 22 or newer, with a semantic version", () => {
  assert.equal(pkg.name, "ai-sdlc-factory");
  assert.equal(pkg.type, "module");
  assert.equal(pkg.engines.node, ">=22");
  assert.match(pkg.version, /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/);
});

test("`files` is the allowlist, and every entry of it exists", () => {
  assert.deepEqual([...pkg.files].sort(), [...ALLOWLIST].sort());
  for (const entry of pkg.files) assert.ok(exists(entry), entry);
});

test("the three commands are declared, exist and start with a node shebang", () => {
  assert.deepEqual(pkg.bin, { "sdlc-bootstrap": "bin/sdlc-bootstrap.mjs", "sdlc-onboard": "bin/sdlc-onboard.mjs", "sdlc-reconcile": "bin/sdlc-reconcile.mjs" });
  for (const target of Object.values(pkg.bin)) {
    assert.ok(read(...target.split("/")).startsWith("#!/usr/bin/env node\n"), target);
  }
});

test("the exports map publishes the public entry points and the schemas, no wildcard into src/, bin/ or tests/, and every target exists", () => {
  assert.deepEqual(Object.keys(pkg.exports).sort(), ["./drift-lib", "./package.json", "./reconcile", "./schemas/*", "./script-kit"]);
  for (const [key, target] of Object.entries(pkg.exports)) {
    assert.equal(typeof target, "string", key);
    if (key.endsWith("*")) {
      assert.equal(target, "./schemas/*");
      continue;
    }
    assert.ok(target === "./package.json" || target.startsWith("./src/"), `${key} -> ${target}`);
    assert.ok(exists(...target.slice(2).split("/")), `${key} -> ${target}`);
  }
});

test("package.json has no lifecycle script: nothing runs when the package is installed from git or packed", () => {
  for (const name of LIFECYCLE) assert.equal(name in (pkg.scripts ?? {}), false, name);
});

test("the dependencies are ranges from the registry, and every package that src/ and bin/ import by a bare name is one of them", () => {
  for (const [name, range] of Object.entries(pkg.dependencies)) assert.match(range, /^\^\d+\.\d+\.\d+$/, name);
  const files = [];
  const walk = (directory) => {
    for (const entry of fs.readdirSync(path.join(REPO_ROOT, directory), { withFileTypes: true })) {
      const relative = `${directory}/${entry.name}`;
      if (entry.isDirectory()) walk(relative);
      else if (entry.name.endsWith(".mjs")) files.push(relative);
    }
  };
  walk("src");
  walk("bin");
  const used = new Set();
  for (const file of files) {
    const text = read(...file.split("/"));
    const specifiers = [
      ...text.matchAll(/^\s*(?:import|export)\b[^;]*?\bfrom\s+["']([^"']+)["']/gm),
      ...text.matchAll(/^\s*import\s+["']([^"']+)["']/gm),
      ...text.matchAll(/(?<![\w.])import\(\s*["']([^"']+)["']\s*\)/g),
    ].map((match) => match[1]);
    for (const specifier of specifiers) {
      if (specifier.startsWith(".") || specifier.startsWith("node:")) continue;
      used.add(specifier.startsWith("@") ? specifier.split("/").slice(0, 2).join("/") : specifier.split("/")[0]);
    }
  }
  assert.ok(used.size > 0, "the scan found the imports");
  for (const name of used) assert.ok(name in pkg.dependencies || name === pkg.name, `${name} is imported and is not a dependency`);
  for (const name of Object.keys(pkg.dependencies)) assert.ok(used.has(name), `${name} is a dependency that nothing imports`);
});

// ---------------------------------------------------------------------------------------------------------------------
// The tarball
// ---------------------------------------------------------------------------------------------------------------------

/** What `npm pack` would put in the tarball, without making one (asked once: npm takes a second or two to start). */
let packedOnce;
function packed() {
  if (packedOnce === undefined) {
    const run = spawnSync("npm pack --dry-run --json --ignore-scripts", { cwd: REPO_ROOT, encoding: "utf8", shell: true });
    assert.equal(run.status, 0, run.stderr);
    const [entry] = JSON.parse(run.stdout);
    packedOnce = { ...entry, paths: entry.files.map((file) => file.path).sort() };
  }
  return packedOnce;
}

const ROOT_FILES = new Set(["package.json", "LICENSE", "README.md", "CHANGELOG.md"]);
const PACKED_DIRECTORIES = ["src/", "bin/", "schemas/", "prompts/"];

test("the tarball holds the allowlist and nothing else", () => {
  const { paths, entryCount } = packed();
  assert.equal(entryCount, paths.length);
  const outside = paths.filter((file) => !ROOT_FILES.has(file) && !PACKED_DIRECTORIES.some((directory) => file.startsWith(directory)));
  assert.deepEqual(outside, []);
});

test("the tarball holds what the commands, the entry points and the renderer read at run time", () => {
  const { paths } = packed();
  for (const required of [
    ...ROOT_FILES,
    ...Object.values(pkg.bin),
    "bin/lib/app-permissions.json",
    "bin/lib/engine-secrets.json",
    "schemas/sdlc.schema.json",
    "schemas/sdlc-routing.schema.json",
    "schemas/bootstrap-summary-report.schema.json",
    "src/reconcile.mjs",
    "src/script-kit.mjs",
    "src/drift/lib/index.mjs",
    "prompts/drift/corroboration.md",
    "prompts/drift/remediation.md",
  ]) {
    assert.ok(paths.includes(required), required);
  }
  for (const target of Object.values(pkg.exports).filter((value) => !value.includes("*"))) assert.ok(paths.includes(target.slice(2)), target);
});

test("the tarball holds no test, tool, document, example, payload, workflow, manifest of the repository, or file of the leak guard", () => {
  const { paths } = packed();
  for (const unwanted of [/^tests\//, /^tools\//, /^docs\//, /^examples\//, /^payload\//, /^\.github\//, /^aw\.yml$/, /^SECURITY\.md$/, /^package-lock\.json$/, /\.test\./, /\.tgz$/, /denylist/i, /allow\.json$/]) {
    assert.deepEqual(paths.filter((file) => unwanted.test(file)), [], String(unwanted));
  }
});

test("every file that the packed modules import by a relative path is in the tarball too", () => {
  const { paths } = packed();
  const set = new Set(paths);
  const missing = [];
  for (const file of paths.filter((candidate) => candidate.endsWith(".mjs"))) {
    const text = read(...file.split("/"));
    const specifiers = [
      ...text.matchAll(/^\s*(?:import|export)\b[^;]*?\bfrom\s+["'](\.[^"']*)["']/gm),
      ...text.matchAll(/^\s*import\s+["'](\.[^"']*)["']/gm),
      ...text.matchAll(/(?<![\w.])import\(\s*["'](\.[^"']*)["']\s*\)/g),
      ...text.matchAll(/new URL\(\s*["'](\.[^"']*)["']\s*,\s*import\.meta\.url/g),
    ].map((match) => match[1]);
    for (const specifier of specifiers) {
      const target = path.posix.normalize(path.posix.join(path.posix.dirname(file), specifier));
      if (!set.has(target) && ![...set].some((candidate) => candidate.startsWith(`${target}/`))) missing.push(`${file} -> ${specifier}`);
    }
  }
  assert.deepEqual(missing, []);
});

// ---------------------------------------------------------------------------------------------------------------------
// The lockfile
// ---------------------------------------------------------------------------------------------------------------------

test("package-lock.json describes this package, and every package in it comes from the public registry with an integrity hash", () => {
  assert.equal(lock.lockfileVersion, 3);
  assert.equal(lock.name, pkg.name);
  assert.equal(lock.version, pkg.version);
  assert.deepEqual(lock.packages[""].dependencies, pkg.dependencies);
  const entries = Object.entries(lock.packages).filter(([name]) => name !== "");
  assert.ok(entries.length >= Object.keys(pkg.dependencies).length);
  for (const [name, entry] of entries) {
    assert.ok(typeof entry.resolved === "string" && entry.resolved.startsWith("https://registry.npmjs.org/"), `${name}: ${entry.resolved}`);
    assert.match(entry.integrity ?? "", /^sha512-/, name);
    assert.notEqual(entry.link, true, name);
  }
});

test("package-lock.json is tracked in git in this repository", () => {
  const outcome = spawnSync("git", ["ls-files", "--error-unmatch", "package-lock.json"], { cwd: REPO_ROOT, encoding: "utf8" });
  assert.equal(outcome.status, 0, outcome.stderr);
});

test("in a git repository where package-lock.json is untracked the same command exits non-zero", () => {
  const workspace = createWorkspace({ files: { "package-lock.json": "{}\n" } });
  try {
    const outcome = spawnSync("git", ["ls-files", "--error-unmatch", "package-lock.json"], { cwd: workspace.dir, encoding: "utf8" });
    assert.notEqual(outcome.status, 0);
  } finally {
    workspace.cleanup();
  }
});

// ---------------------------------------------------------------------------------------------------------------------
// The CI workflow
// ---------------------------------------------------------------------------------------------------------------------

const ciText = read(".github", "workflows", "ci.yml");
const ci = YAML.parse(ciText);
// the workflow without its comment lines: a comment may name what the workflow never does
const ciCode = ciText.split("\n").filter((line) => !/^\s*#/.test(line)).join("\n");
const absent = (pattern, text, label) => assert.equal(pattern.test(text), false, `${label}: ${pattern} matches`);
const jobs = Object.entries(ci.jobs);
const stepsOf = (job) => ci.jobs[job].steps;
const runsOf = (job) => stepsOf(job).filter((step) => typeof step.run === "string").map((step) => step.run);
const indexOfStep = (job, predicate) => stepsOf(job).findIndex(predicate);

test("the workflow parses without errors or warnings", () => {
  const document = YAML.parseDocument(ciText);
  assert.deepEqual(document.errors, []);
  assert.deepEqual(document.warnings, []);
  assert.equal(ci.name, "CI");
});

test("the workflow runs on pull_request, push and by hand, and never on a trigger that gives code from a fork a token", () => {
  assert.deepEqual(Object.keys(ci.on).sort(), ["pull_request", "push", "workflow_dispatch"]);
  assert.deepEqual(ci.on.push.branches, ["main"]);
  assert.deepEqual(ci.on.push.tags, ["v*"]);
  absent(/pull_request_target|workflow_run|issue_comment/, ciCode, "a trigger that runs with a token on code from a fork");
});

test("the workflow has the six jobs that guard the repository", () => {
  assert.deepEqual(Object.keys(ci.jobs).sort(), ["consumer-smoke", "examples-drift", "leak-guard", "pack-check", "test", "test-windows"]);
});

test("the workflow token is read-only: no permission at the top, contents: read and a timeout in every job", () => {
  assert.deepEqual(ci.permissions, {});
  for (const [name, job] of jobs) {
    assert.deepEqual(job.permissions, { contents: "read" }, name);
    // The full suite on a hosted runner, on Windows above all, needs more than an hour; every other job stays within one.
    const limit = name === "test" || name === "test-windows" ? 90 : 60;
    assert.ok(Number.isInteger(job["timeout-minutes"]) && job["timeout-minutes"] <= limit, `${name} has a timeout of ${limit} minutes or less`);
  }
});

test("the workflow uses no secret and does not inherit any", () => {
  absent(/\$\{\{\s*secrets\b|\bsecrets\.|secrets:\s*inherit/, ciCode, "a secret");
  absent(/\bGITHUB_TOKEN\b|\bpat\b/i, ciCode, "a token by another name");
});

test("no run script contains an expression: what a step needs from the context goes through env", () => {
  for (const [name] of jobs) for (const run of runsOf(name)) assert.equal(run.includes("${{"), false, `${name}: ${run.slice(0, 80)}`);
});

test("every action is pinned to a full commit SHA with the version in a comment, each action to one SHA, and only the three known actions are used", () => {
  const lines = ciText.split("\n").filter((line) => /^\s*(?:-\s+)?uses:/.test(line));
  assert.ok(lines.length >= 10);
  const shas = new Map();
  for (const line of lines) {
    const match = /uses:\s+([\w.-]+\/[\w.-]+(?:\/[\w./-]+)?)@([0-9a-f]{40}) # (v\d+\.\d+\.\d+)\s*$/.exec(line);
    assert.ok(match !== null, `pinned by SHA with a version comment: ${line.trim()}`);
    const [, action, sha, version] = match;
    assert.equal(shas.get(action) ?? `${sha} ${version}`, `${sha} ${version}`, `${action} is pinned to one SHA`);
    shas.set(action, `${sha} ${version}`);
  }
  assert.deepEqual([...shas.keys()].sort(), ["actions/checkout", "actions/setup-node", "github/gh-aw/actions/setup-cli"]);
});

test("every checkout drops the credentials, and the leak guard gets the whole history", () => {
  for (const [name] of jobs) {
    const checkouts = stepsOf(name).filter((step) => String(step.uses).startsWith("actions/checkout@"));
    assert.equal(checkouts.length, 1, name);
    assert.equal(checkouts[0].with["persist-credentials"], false, name);
  }
  const [checkout] = stepsOf("leak-guard").filter((step) => String(step.uses).startsWith("actions/checkout@"));
  assert.equal(checkout.with["fetch-depth"], 0);
});

/**
 * Evaluates the one kind of condition that the Windows job has: `||` of `github.event_name == 'x'` and `startsWith(github.ref, 'y')`. Any other form is refused, so that a
 * changed condition fails the test and is not guessed at.
 */
function holds(expression, { event, ref }) {
  return expression.split("||").some((operand) => {
    const text = operand.trim();
    let match = /^github\.event_name == '([a-z_]+)'$/.exec(text);
    if (match) return event === match[1];
    match = /^startsWith\(github\.ref, '([^']+)'\)$/.exec(text);
    if (match) return ref.startsWith(match[1]);
    throw new Error(`the test cannot evaluate '${text}'`);
  });
}

/** The steps of a test job as text, with the node version that each one asks for taken out: Ubuntu reads it from the matrix and Windows names it. */
const stepsWithoutNode = (job) => JSON.stringify(stepsOf(job), (key, value) => (key === "node-version" ? "<node>" : value));

function assertTestSteps(job) {
  const runs = runsOf(job);
  const ciIndex = runs.findIndex((run) => run === "npm ci --ignore-scripts");
  const testIndex = runs.findIndex((run) => run === "npm test");
  assert.ok(ciIndex !== -1 && testIndex > ciIndex, `${job}: npm ci, then npm test`);
  assert.match(runs.find((run) => run.includes("user.email")), /git config --global user\.email "ci@example\.invalid"/, job);
}

test("the test job runs npm ci and npm test on Ubuntu with Node.js 22 and 24, for every trigger", () => {
  const job = ci.jobs.test;
  assert.deepEqual(job.strategy.matrix, { node: ["22", "24"] });
  assert.equal(job.strategy["fail-fast"], false);
  assert.equal(job["runs-on"], "ubuntu-latest");
  assert.equal(job.if, undefined, "no condition: a push to main, a pull request, a tag and a manual run all run it");
  assertTestSteps("test");
  absent(/--registry/, ciCode, "a registry override: the lockfile names the registry");
});

test("the Windows job runs the same steps with Node.js 24 for a pull request, a release tag and a manual run, and not for a push to a branch", () => {
  const job = ci.jobs["test-windows"];
  assert.equal(job["runs-on"], "windows-latest");
  assert.equal(job.strategy, undefined);
  assert.equal(stepsOf("test-windows").find((step) => String(step.uses).startsWith("actions/setup-node@")).with["node-version"], "24");
  assert.equal(stepsWithoutNode("test-windows"), stepsWithoutNode("test"), "the Windows leg is the Ubuntu leg's steps, so what runs on one is what runs on the other");
  assertTestSteps("test-windows");
  assert.equal(typeof job.if, "string");
  const cases = [
    ["a push to main", { event: "push", ref: "refs/heads/main" }, false],
    ["a push of a release tag", { event: "push", ref: "refs/tags/v0.1.0" }, true],
    ["a pull request", { event: "pull_request", ref: "refs/pull/7/merge" }, true],
    ["a manual run", { event: "workflow_dispatch", ref: "refs/heads/main" }, true],
  ];
  for (const [label, context, expected] of cases) assert.equal(holds(job.if, context), expected, label);
});

test("the leak guard job scans the tree always, and the history with its annotated tags except for a pull request", () => {
  const steps = stepsOf("leak-guard");
  const tree = steps.find((step) => step.run === "node tools/leak-guard/scan.mjs --tree");
  const history = steps.find((step) => step.run === "node tools/leak-guard/scan.mjs --history");
  assert.ok(tree !== undefined && history !== undefined);
  assert.equal(tree.if, undefined);
  assert.equal(history.if, "github.event_name != 'pull_request'");
});

test("examples-drift installs the gh-aw release that examples/.gh-aw-version names, regenerates the examples with it and fails on any difference", () => {
  const read_ = indexOfStep("examples-drift", (step) => step.id === "ghaw");
  const setup = indexOfStep("examples-drift", (step) => String(step.uses).startsWith("github/gh-aw/actions/setup-cli@"));
  const install = indexOfStep("examples-drift", (step) => step.run === "npm ci --ignore-scripts");
  const update = indexOfStep("examples-drift", (step) => typeof step.run === "string" && step.run.includes("node tools/update-examples.mjs --compile"));
  const compare = indexOfStep("examples-drift", (step) => typeof step.run === "string" && step.run.includes("git diff --exit-code -- examples"));
  assert.ok(read_ !== -1 && setup > read_ && install !== -1 && update > setup && update > install && compare > update, [read_, setup, install, update, compare].join(","));
  const steps = stepsOf("examples-drift");
  assert.match(steps[read_].run, /examples\/\.gh-aw-version/);
  assert.equal(steps[setup].with.version, "${{ steps.ghaw.outputs.version }}");
  assert.match(steps[compare].run, /git ls-files --others --exclude-standard -- examples/, "a file that the render adds is a difference too");
  assert.equal(steps[update].env.GH_TOKEN, "${{ github.token }}");
});

test("pack-check lists the package and runs this file", () => {
  const runs = runsOf("pack-check");
  const install = runs.indexOf("npm ci --ignore-scripts");
  assert.ok(install !== -1);
  assert.ok(runs.indexOf("npm pack --dry-run --ignore-scripts") > install);
  assert.ok(runs.indexOf("node --test tests/s5/template-structure.test.mjs") > install);
  assert.ok(exists("tests", "s5", "template-structure.test.mjs"));
});

const smokeStep = () => stepsOf("consumer-smoke").find((step) => typeof step.run === "string" && step.run.includes("<<'EOF'"));
const smokeScript = () => /<<'EOF'\n([\s\S]*?)\nEOF\n?$/.exec(smokeStep().run)?.[1];

test("consumer-smoke packs the package, installs the tarball into a scratch project and runs the command and the exports there", () => {
  const runs = runsOf("consumer-smoke");
  const pack = runs.find((run) => run.includes("npm pack"));
  assert.match(pack, /mkdir "\$RUNNER_TEMP\/pack"\nnpm pack --ignore-scripts --pack-destination "\$RUNNER_TEMP\/pack"/, "the destination exists before npm writes to it");
  const install = runs.find((run) => run.includes("npm install"));
  assert.match(install, /npm install --ignore-scripts --no-audit --no-fund "\$RUNNER_TEMP"\/pack\/ai-sdlc-factory-\*\.tgz/);
  assert.ok(runs.indexOf(pack) < runs.indexOf(install));
  const step = smokeStep();
  assert.equal(step["working-directory"], "${{ runner.temp }}/consumer");
  assert.equal(step.env.EXAMPLES, "${{ github.workspace }}/examples");
  assert.match(step.run, /npx --no-install sdlc-reconcile --help \| grep -F -- '--request <file>'/);
  assert.match(step.run, /test -e node_modules\/\.bin\/sdlc-bootstrap\ntest -e node_modules\/\.bin\/sdlc-onboard/);
  assert.ok(smokeScript() !== undefined, "the script is a quoted here-document");
});

test("the run scripts of the Ubuntu jobs are valid bash", { skip: have("bash", ["--version"]) ? false : "bash is not installed" }, () => {
  let count = 0;
  for (const [name, job] of jobs) {
    if (!String(job["runs-on"]).startsWith("ubuntu")) continue;
    for (const run of runsOf(name)) {
      const outcome = spawnSync("bash", ["-n"], { input: run, encoding: "utf8" });
      assert.equal(outcome.status, 0, `${name}: ${outcome.stderr}`);
      count += 1;
    }
  }
  assert.ok(count >= 10);
});

test("the script of consumer-smoke is a valid module", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sdlc-ci-smoke-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, "smoke.mjs");
  fs.writeFileSync(file, smokeScript());
  const outcome = spawnSync(process.execPath, ["--check", file], { encoding: "utf8" });
  assert.equal(outcome.status, 0, outcome.stderr);
});

// What the job does, offline: the tarball is unpacked where npm would put it, and the three dependencies are those of this checkout.
const tarOk = have("tar", ["--version"]);

function installPackedPackage(t) {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "sdlc-ci-consumer-"));
  t.after(() => fs.rmSync(scratch, { recursive: true, force: true }));
  const pack = path.join(scratch, "pack");
  fs.mkdirSync(pack);
  const made = spawnSync(`npm pack --ignore-scripts --silent --pack-destination "${pack}"`, { cwd: REPO_ROOT, encoding: "utf8", shell: true });
  assert.equal(made.status, 0, made.stderr);
  const tarball = made.stdout.trim().split("\n").pop().trim();
  const modules = path.join(scratch, "consumer", "node_modules");
  const installed = path.join(modules, pkg.name);
  fs.mkdirSync(installed, { recursive: true });
  // relative paths: a GNU tar reads `C:` of an absolute path as a host name
  const untar = spawnSync("tar", ["-xzf", tarball, "-C", path.relative(pack, installed), "--strip-components=1"], { cwd: pack, encoding: "utf8" });
  assert.equal(untar.status, 0, untar.stderr);
  for (const entry of fs.readdirSync(path.join(REPO_ROOT, "node_modules"))) {
    if (entry.startsWith(".") || entry === pkg.name) continue;
    fs.cpSync(path.join(REPO_ROOT, "node_modules", entry), path.join(modules, entry), { recursive: true });
  }
  return { consumer: path.join(scratch, "consumer"), installed };
}

function runSmoke(consumer, examples) {
  return spawnSync(process.execPath, ["--input-type=module", "-"], { cwd: consumer, input: smokeScript(), env: { ...process.env, EXAMPLES: examples }, encoding: "utf8" });
}

test("the consumer-smoke script passes with the packed package, and fails when a committed file differs from the render or the exports map lets a deep import through", { skip: tarOk ? false : "tar is not installed" }, (t) => {
  const { consumer, installed } = installPackedPackage(t);
  const help = spawnSync(process.execPath, [path.join(installed, "bin", "sdlc-reconcile.mjs"), "--help"], { cwd: consumer, encoding: "utf8" });
  assert.equal(help.status, 0, help.stderr);
  assert.ok(help.stdout.includes("--request <file>"));

  const fleet = createFleetWorkspace(t);
  const request = referenceRequest();
  fleet.write("request.reference.json", JSON.stringify(request));
  const rendered = renderFleet(request, { cwd: fleet.dir });
  assert.equal(rendered.ok, true);
  for (const [file, text] of rendered.files) fleet.write(file, text);

  const passed = runSmoke(consumer, fleet.dir);
  assert.equal(passed.status, 0, passed.stderr);
  assert.match(passed.stdout, new RegExp(`renders the ${rendered.files.size} files of examples/ exactly as they are committed`));

  const [file] = [...rendered.files.keys()];
  fleet.write(file, `${rendered.files.get(file)}# changed\n`);
  const different = runSmoke(consumer, fleet.dir);
  assert.notEqual(different.status, 0);
  assert.match(different.stderr, new RegExp(`renders examples/ differently from the committed files: ${file.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
  fleet.write(file, rendered.files.get(file));

  const installedPackage = JSON.parse(fs.readFileSync(path.join(installed, "package.json"), "utf8"));
  installedPackage.exports["./src/*"] = "./src/*";
  fs.writeFileSync(path.join(installed, "package.json"), JSON.stringify(installedPackage));
  const open = runSmoke(consumer, fleet.dir);
  assert.notEqual(open.status, 0);
  assert.match(open.stderr, /a deep import into src\/ resolved/);
});

// ---------------------------------------------------------------------------------------------------------------------
// The central repository comes from the origin remote
// ---------------------------------------------------------------------------------------------------------------------

test("the resolver returns owner/repo of the origin remote of the working copy that holds the manifest", () => {
  const workspace = createWorkspace({ origin: "https://github.com/example-owner/example-repo.git" });
  try {
    const central = resolveCentralRepo("sdlc.yaml", { cwd: workspace.dir });
    assert.equal(central.slug, "example-owner/example-repo");
    assert.equal(central.owner, "example-owner");
    assert.equal(central.repo, "example-repo");
    assert.equal(fs.realpathSync.native(central.workingCopy), fs.realpathSync.native(workspace.dir));
  } finally {
    workspace.cleanup();
  }
});

test("a manifest in a subdirectory resolves the origin of the enclosing working copy", () => {
  const workspace = createWorkspace({ origin: "https://github.com/example-owner/example-repo.git", files: { "config/fleet.yaml": "projects: []\n" } });
  try {
    const central = resolveCentralRepo("config/fleet.yaml", { cwd: workspace.dir });
    assert.equal(central.slug, "example-owner/example-repo");
    assert.equal(fs.realpathSync.native(central.workingCopy), fs.realpathSync.native(workspace.dir));
  } finally {
    workspace.cleanup();
  }
});

test("a manifest reached through a link to the working copy resolves to the canonical working copy", () => {
  const workspace = createWorkspace({ origin: "https://github.com/example-owner/example-repo.git" });
  try {
    const link = path.join(workspace.root, "link");
    fs.symlinkSync(workspace.dir, link, "junction");
    const central = resolveCentralRepo("sdlc.yaml", { cwd: link });
    assert.equal(central.workingCopy, fs.realpathSync.native(workspace.dir));
    assert.equal(workspaceManifestPath(central.workingCopy, central.manifestPath), "sdlc.yaml");
  } finally {
    workspace.cleanup();
  }
});

test("with no origin the resolver fails with a non-zero exit, as a function and as a command", () => {
  const workspace = createWorkspace({ origin: null });
  try {
    assert.throws(() => resolveCentralRepo("sdlc.yaml", { cwd: workspace.dir }), /no 'origin' remote/);
    const outcome = spawnSync(process.execPath, [path.join(REPO_ROOT, "bin", "lib", "central-repo.mjs"), path.join(workspace.dir, "sdlc.yaml")], { encoding: "utf8" });
    assert.notEqual(outcome.status, 0);
    assert.match(outcome.stderr, /no 'origin' remote/);
    assert.equal(outcome.stdout, "");
  } finally {
    workspace.cleanup();
  }
});

test("the command form prints owner/repo and exits zero", () => {
  const workspace = createWorkspace({ origin: "git@github.com:example-owner/example-repo.git" });
  try {
    const outcome = spawnSync(process.execPath, [path.join(REPO_ROOT, "bin", "lib", "central-repo.mjs"), path.join(workspace.dir, "sdlc.yaml")], { encoding: "utf8" });
    assert.equal(outcome.status, 0, outcome.stderr);
    assert.equal(outcome.stdout.trim(), "example-owner/example-repo");
  } finally {
    workspace.cleanup();
  }
});

test("a manifest outside any git working copy cannot be resolved", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "sdlc-s5-nogit-"));
  try {
    fs.writeFileSync(path.join(directory, "sdlc.yaml"), "projects: []\n");
    assert.throws(() => resolveCentralRepo("sdlc.yaml", { cwd: directory, env: { ...process.env, GIT_CEILING_DIRECTORIES: path.dirname(directory) } }), /not inside a git working copy/);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

for (const [url, expected] of [
  ["https://github.com/example-owner/example-repo.git", "example-owner/example-repo"],
  ["https://github.com/example-owner/example-repo", "example-owner/example-repo"],
  ["https://github.com/example-owner/example-repo/", "example-owner/example-repo"],
  ["https://user:secret@github.com/example-owner/example-repo.git", "example-owner/example-repo"],
  ["git@github.com:example-owner/example-repo.git", "example-owner/example-repo"],
  ["ssh://git@github.com/example-owner/example-repo.git", "example-owner/example-repo"],
  ["https://ghe.example.com/example-owner/example-repo.git", "example-owner/example-repo"],
  ["file:///srv/git/example-repo.git", null],
  ["not a url", null],
  ["https://github.com/only-one-segment", null],
]) {
  test(`the origin URL ${JSON.stringify(url.replace(/secret/, "***"))} resolves to ${JSON.stringify(expected)}`, () => {
    assert.equal(parseRemoteUrl(url), expected);
  });
}

test("a credential in the origin URL never reaches a diagnostic", () => {
  const workspace = createWorkspace({ origin: "https://user:topsecret@github.com/just-one" });
  try {
    assert.throws(
      () => resolveCentralRepo("sdlc.yaml", { cwd: workspace.dir }),
      (error) => !error.message.includes("topsecret") && /does not name an <owner>\/<repo>/.test(error.message),
    );
  } finally {
    workspace.cleanup();
  }
});

test("the resolver is the only source of the central repository: a different origin gives a different answer, with no literal to change", () => {
  const workspace = createWorkspace({ origin: "https://github.com/another-owner/another-repo.git" });
  try {
    assert.equal(resolveCentralRepo("sdlc.yaml", { cwd: workspace.dir }).slug, "another-owner/another-repo");
    execFileSync("git", ["remote", "set-url", "origin", "https://github.com/third-owner/third-repo.git"], { cwd: workspace.dir });
    assert.equal(resolveCentralRepo("sdlc.yaml", { cwd: workspace.dir }).slug, "third-owner/third-repo");
  } finally {
    workspace.cleanup();
  }
});
