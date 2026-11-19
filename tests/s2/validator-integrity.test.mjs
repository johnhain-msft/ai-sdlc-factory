// AC22, staged scripts: the post-step runs the example validator, and $GITHUB_WORKSPACE is the
// working directory that the agent step can write (the compiled `awf` command has --container-workdir "${GITHUB_WORKSPACE}"), so an agent that
// rewrites that file, or a module that it imports, would be the code that judges it. prepare-run, which runs before the agent starts, therefore stages
// a copy of the declared scripts and the installed factory's src/drift/lib/ under ${RUNNER_TEMP}/gh-aw/sdlc-validator/, read-only (the agent step mounts
// ${RUNNER_TEMP}/gh-aw read-only). The preset's compare-then-run command rejects a difference or missing copy with exit 1: it compares the declared script, the
// factory's package.json (its `exports` say where `ai-sdlc-factory/drift-lib` is) and src/drift/lib/, and it refuses a scripts/node_modules directory (Node looks for
// the package there before it looks in the workspace's own node_modules, so a package of the agent's would be found first). It then runs the STAGED copy of the script,
// not the workspace one: Node decides what `ai-sdlc-factory/drift-lib` is from where the script is, and in the workspace a package.json that names itself
// ai-sdlc-factory (scripts/package.json, or the workspace's own) is found before any node_modules, which no comparison of files covers.
// The tests below run the rendered steps in the order of a job, with isolated copies in the workspace that the
// "agent" rewrites, and show that the gate exits 1; with the comparison taken out the same rewrite passes, which is what makes the tests tests.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { run as prepare } from "../../src/drift/prepare-run.mjs";
import { VALIDATOR_STAGE_DIRECTORY } from "../../src/drift/lib/cli.mjs";
import { installFactory } from "../helpers/adopter.mjs";
import { presetAbs } from "../helpers/preset.mjs";
import { targetFiles, withoutSection } from "../helpers/target-fixture.mjs";
import { abs, DRIFT_KEYS, driftPreset, driftWorkflow, FACTORY_DIR, forceRemove, listTree, renderedVerifyCommands, stepWith, tempDir } from "./helpers/fixtures.mjs";
import { BASH_SKIP, createGateWorkspace } from "./helpers/gate-harness.mjs";
import { createRepo } from "./helpers/git-fixture.mjs";
import { invoke, isUnder, recordingFs } from "./helpers/run-script.mjs";
import { cleanEnv } from "./helpers/stub-server.mjs";

const TARGET = "example-org/example-target";
const STAGED_KEYS = DRIFT_KEYS.filter((key) => driftPreset(key).driftAudit.stagedScripts?.length > 0);
const CHECKOUT = driftPreset("lab-content").repo.split("/")[1];
const VALIDATOR = "scripts/validate-example.mjs";
const posixOnly = process.platform === "win32" ? "directory modes are not enforced on Windows" : false;

/** The stage mirrors the workspace: scripts at their declared paths, and support files under the factory directory. */
const expectedStaged = () => [VALIDATOR, `${FACTORY_DIR}/package.json`, ...listTree(abs("src", "drift", "lib")).map((file) => `${FACTORY_DIR}/src/drift/lib/${file}`)].sort();
const prepareArgs = (run, name) => ["--out", run.out(name), "--target-repo", TARGET, "--factory-dir", FACTORY_DIR, "--stage-scripts", VALIDATOR];
const stageSource = (run, relative) => relative.startsWith(`${FACTORY_DIR}/`) ? abs(...relative.slice(FACTORY_DIR.length + 1).split("/")) : path.join(run.workspace, ...relative.split("/"));

/** A job's workspace with a target checkout, a RUNNER_TEMP and the environment that the runner gives the first step. */
function job() {
  const root = tempDir("sdlc-s2-stage-");
  const workspace = path.join(root, "workspace");
  const runnerTemp = path.join(root, "runner-temp");
  fs.mkdirSync(runnerTemp, { recursive: true });
  const checkout = createRepo({ "README.md": "target\n" }, { dir: path.join(workspace, "example-target") });
  installFactory(workspace);
  fs.mkdirSync(path.join(workspace, "scripts"));
  fs.copyFileSync(presetAbs("scripts", "validate-example.mjs"), path.join(workspace, VALIDATOR));
  const stage = path.join(runnerTemp, "gh-aw", VALIDATOR_STAGE_DIRECTORY);
  const env = (extra = {}) => cleanEnv({ GITHUB_WORKSPACE: workspace, CONFIGURED_TARGET_REPO: TARGET, RUNNER_TEMP: runnerTemp, ...extra });
  return { root, workspace, runnerTemp, stage, env, checkout, out: (name = "agent") => path.join(root, name), cleanup: () => forceRemove(root) };
}

test("AC22: prepare-run stages the validator and the modules that it imports under ${RUNNER_TEMP}/gh-aw/sdlc-validator/, byte for byte, and says so", async () => {
  const run = job();
  try {
    const result = await invoke(prepare, prepareArgs(run), { env: run.env(), cwd: run.root });
    assert.equal(result.code, 0, result.stderr);
    assert.deepEqual(listTree(run.stage), expectedStaged());
    assert.ok(expectedStaged().length >= 4, "the validator and the modules of drift/lib/");
    for (const relative of expectedStaged()) {
      assert.ok(fs.readFileSync(path.join(run.stage, ...relative.split("/"))).equals(fs.readFileSync(stageSource(run, relative))), `${relative} is a copy of its workspace script or factory source`);
    }
    assert.match(result.stdout, new RegExp(`${expectedStaged().length} validator files staged read-only under `));
    assert.equal(listTree(run.stage).some((file) => /reconcile|prepare-run|dedupe|escalate|snapshot/.test(file)), false, "and nothing else of src/ is copied");
  } finally {
    run.cleanup();
  }
});

test("AC22: the staged files are read-only (0444) and so are the directories (0555), so that nothing that runs as the agent's user can rewrite the copy it is compared with", { skip: posixOnly }, async () => {
  const run = job();
  try {
    assert.equal((await invoke(prepare, prepareArgs(run), { env: run.env(), cwd: run.root })).code, 0);
    for (const relative of expectedStaged()) assert.equal(fs.statSync(path.join(run.stage, ...relative.split("/"))).mode & 0o777, 0o444, relative);
    for (const directory of ["", "scripts", "node_modules", FACTORY_DIR, `${FACTORY_DIR}/src`, `${FACTORY_DIR}/src/drift`, `${FACTORY_DIR}/src/drift/lib`]) assert.equal(fs.statSync(path.join(run.stage, ...directory.split("/"))).mode & 0o777, 0o555, directory || "(the stage)");
    if (process.getuid?.() !== 0) assert.throws(() => fs.writeFileSync(path.join(run.stage, VALIDATOR), "process.exit(0);\n"), /EACCES|EPERM/);
  } finally {
    run.cleanup();
  }
});

test("AC22: a read-only file is read-only on every platform: the copy cannot be opened for writing", async () => {
  const run = job();
  try {
    assert.equal((await invoke(prepare, prepareArgs(run), { env: run.env(), cwd: run.root })).code, 0);
    if (process.getuid?.() !== 0) assert.throws(() => fs.writeFileSync(path.join(run.stage, FACTORY_DIR, "src", "drift", "lib", "args.mjs"), "export {};\n"), /EACCES|EPERM/);
  } finally {
    run.cleanup();
  }
});

test("AC22: a second run in the same RUNNER_TEMP replaces the stage, although its files and directories are read-only, and leaves no stale file", async () => {
  const run = job();
  try {
    assert.equal((await invoke(prepare, prepareArgs(run, "one"), { env: run.env(), cwd: run.root })).code, 0);
    const stale = path.join(run.stage, FACTORY_DIR, "src", "drift", "lib", "stale.mjs");
    fs.chmodSync(path.dirname(stale), 0o755);
    fs.writeFileSync(stale, "export {};\n");
    const again = await invoke(prepare, prepareArgs(run, "two"), { env: run.env(), cwd: run.root });
    assert.equal(again.code, 0, again.stderr);
    assert.deepEqual(listTree(run.stage), expectedStaged(), "the stale file is gone");
  } finally {
    run.cleanup();
  }
});

test("AC22: outside Actions (no RUNNER_TEMP) nothing is staged, and a RUNNER_TEMP that cannot hold the stage stops the step before the agent starts, with nothing written under --out", async () => {
  const run = job();
  try {
    const outside = await invoke(prepare, prepareArgs(run, "none"), { env: run.env({ RUNNER_TEMP: "" }), cwd: run.root });
    assert.equal(outside.code, 0, outside.stderr);
    assert.doesNotMatch(outside.stdout, /staged/);
    assert.equal(fs.existsSync(run.stage), false);
    fs.writeFileSync(path.join(run.runnerTemp, "gh-aw"), "a file where the directory has to be\n");
    const refused = await invoke(prepare, prepareArgs(run, "refused"), { env: run.env(), cwd: run.root });
    assert.equal(refused.code, 1, "the validator that the gate would compare with cannot be staged");
    assert.match(refused.stderr, /prepare-run: the validator cannot be staged under /);
    assert.equal(fs.existsSync(run.out("refused")), false, "and nothing is left under --out");
  } finally {
    run.cleanup();
  }
});

test("AC5 and AC22: with RUNNER_TEMP set, prepare-run still writes under --out, the file that GITHUB_ENV names and the staged validator, and nowhere else", async () => {
  const run = job();
  const recorder = recordingFs();
  const envFile = path.join(run.root, "github-env");
  fs.writeFileSync(envFile, "");
  try {
    const result = await invoke(prepare, prepareArgs(run), { env: run.env({ GITHUB_ENV: envFile }), cwd: run.root, fs: recorder.fs });
    assert.equal(result.code, 0, result.stderr);
    const sources = new Set(expectedStaged().map((relative) => path.resolve(stageSource(run, relative))));
    const elsewhere = recorder.writes.filter((written) => !isUnder(written, run.out()) && !isUnder(written, run.stage) && path.resolve(written) !== path.resolve(envFile) && !sources.has(path.resolve(written)));
    assert.deepEqual(elsewhere, [], "no other path is written (the recorder also lists the exact source file of every copy)");
    assert.ok(recorder.writes.some((written) => isUnder(written, run.stage)), "the stage is written");
    assert.equal(fs.readFileSync(envFile, "utf8"), `SDLC_BASE_SHA=${run.checkout.head()}\n`, "and GITHUB_ENV still gets its one line");
    assert.equal(run.checkout.status(), "", "the target checkout is as it was");
    assert.deepEqual(listTree(run.out()), ["run-context.json"], "the staged copy is not an artifact: --out holds the run context alone");
  } finally {
    run.cleanup();
  }
});

for (const key of STAGED_KEYS) {
  test(`AC22: the validator entry of drift-${key} compares the declared script, the factory's package.json and drift/lib with the staged copy, refuses scripts/node_modules, fails closed, and then runs the staged validator`, () => {
    const command = renderedVerifyCommands(key)[0];
    assert.equal(driftWorkflow(key).frontmatter["post-steps"][0].run, command, "the rendered step expands only the manifest's factory placeholders");
    const prepareStep = stepWith(driftWorkflow(key).frontmatter["pre-agent-steps"], "drift/prepare-run.mjs");
    assert.ok(prepareStep.run.endsWith(` --factory-dir ${FACTORY_DIR} --stage-scripts ${driftPreset(key).driftAudit.stagedScripts.join(",")}`));
    const pieces = [
      'copy="${RUNNER_TEMP:?RUNNER_TEMP is not set}/gh-aw/sdlc-validator"',
      `cmp -s "$copy/${VALIDATOR}" "$GITHUB_WORKSPACE/${VALIDATOR}"`,
      `cmp -s "$copy/${FACTORY_DIR}/package.json" "$GITHUB_WORKSPACE/${FACTORY_DIR}"/package.json`,
      `diff -rq "$copy/${FACTORY_DIR}/src/drift/lib" "$GITHUB_WORKSPACE/${FACTORY_DIR}"/src/drift/lib`,
      '! test -e "$GITHUB_WORKSPACE/scripts/node_modules"',
    ];
    let from = -1;
    for (const piece of pieces) {
      const at = command.indexOf(piece, from + 1);
      assert.ok(at > from, `${piece} comes in this order`);
      from = at;
    }
    assert.ok(command.indexOf(`node "$copy/${VALIDATOR}"`) > from, "and the staged validator runs after the comparisons");
    assert.equal(command.includes('node "$GITHUB_WORKSPACE/'), false, "the workspace copy is compared, never run: what the agent can write does not decide what imports resolve to");
    assert.equal(command.match(/\|\| \{ echo "[^"]+" >&2; exit 1; \}/g).length, 4, "each comparison that fails, and the refusal, ends the command with exit 1");
    assert.match(command, /^\( set -euo pipefail; /);
    assert.equal(/staged/.test(command), false, "SPEC-01's staging-key scans read the whole rendered file for the word, so the command does not use it");
    assert.equal(/\|\|\s*(?:true|:)\b|;\s*exit\s+0\b|--retry/.test(command), false, "nothing turns a failure into a pass");
    assert.equal(driftPreset(key).driftAudit.verifyCommands.filter((candidate) => candidate.includes(VALIDATOR)).length, 1, "one entry runs the validator");
  });
}

/** The agent's way of rewriting a file of the orchestrator checkout, which is the working directory of its step. */
const agentWrites = (gate, relative, text) => fs.writeFileSync(path.join(gate.workspace, ...relative.split("/")), text);
/** The target has a report that the real example validator rejects, regardless of the script-integrity comparison. */
function invalidateAndCommit(gate, key) {
  const improvement = key === "agent-kit";
  const file = improvement ? "reports/improvement-report.md" : "reports/audit-report.md";
  gate.write(file, withoutSection(targetFiles()[file], improvement ? "Findings" : "Verification"));
  gate.git("add", "-A");
  gate.git("commit", "-q", "-m", "remove a required report section");
}
const ALWAYS_PASSES = "process.exit(0);\n";

/** What the agent's replacement of ai-sdlc-factory/drift-lib prints: everything of the real module is re-exported, except that runAsMain reports success and exits 0. */
const NEUTRALISED = "validator neutralised by the agent";
const neutralisedModule = (realIndex) => `export * from ${JSON.stringify(pathToFileURL(realIndex).href)};\nexport async function runAsMain() { await new Promise((resolve) => process.stdout.write(${JSON.stringify(`${NEUTRALISED}\n`)}, resolve)); process.exit(0); }\n`;
const installedFactory = (gate) => path.join(gate.workspace, ...FACTORY_DIR.split("/"));
const installedIndex = (gate) => path.join(installedFactory(gate), "src", "drift", "lib", "index.mjs");
/** The package.json by which a directory of the workspace makes `import "ai-sdlc-factory/drift-lib"` resolve to ./neutralised.mjs (Node's package self-reference). */
const selfReferencing = () => `${JSON.stringify({ name: "ai-sdlc-factory", type: "module", exports: { "./drift-lib": "./neutralised.mjs" } })}\n`;
/**
 * What the validator itself says about the report that invalidateAndCommit leaves: the honest validator ran, and this is its verdict (the agent's module prints
 * NEUTRALISED and exits 0 instead).
 */
const VALIDATOR_VERDICT = {
  "lab-content": "validate-example: reports/audit-report.md has no '## Verification' section",
  "agent-kit": "validate-example: reports/improvement-report.md has no '## Findings' section",
};
/**
 * The four ways to make `import "ai-sdlc-factory/drift-lib"` in the validator of the workspace load a module of the agent's, other than rewriting a file that the gate
 * compares: the `exports` of the installed package.json say where drift-lib is (A), Node looks for the package in scripts/node_modules before it looks in the workspace's
 * node_modules (B), and a package.json that names itself ai-sdlc-factory makes the package find itself before any node_modules does, in scripts/ (C1) or in the workspace
 * root (C2). `refused` is what the gate names when a comparison or the refusal stops it (A, B); for C1 and C2 nothing is compared, because the gate runs the staged
 * validator, which no file of the workspace can reach: `refused` is null, and the gate's verdict is the validator's own.
 */
const RESOLUTION_TAMPERS = {
  "rewrites exports['./drift-lib'] of the installed factory's package.json to a module of its own": {
    refused: `${FACTORY_DIR}/package.json`,
    tamper(gate) {
      const factory = installedFactory(gate);
      const manifest = JSON.parse(fs.readFileSync(path.join(factory, "package.json"), "utf8"));
      fs.writeFileSync(path.join(factory, "neutralised.mjs"), neutralisedModule(installedIndex(gate)));
      manifest.exports["./drift-lib"] = "./neutralised.mjs";
      fs.writeFileSync(path.join(factory, "package.json"), `${JSON.stringify(manifest, null, 2)}\n`);
    },
  },
  "adds scripts/node_modules/ai-sdlc-factory, which Node finds before the installed factory": {
    refused: "scripts/node_modules",
    tamper(gate) {
      const shadow = path.join(gate.workspace, "scripts", "node_modules", "ai-sdlc-factory");
      fs.mkdirSync(shadow, { recursive: true });
      fs.writeFileSync(path.join(shadow, "package.json"), selfReferencing());
      fs.writeFileSync(path.join(shadow, "neutralised.mjs"), neutralisedModule(installedIndex(gate)));
    },
  },
  "adds scripts/package.json that names itself ai-sdlc-factory, so that the package finds itself before any node_modules": {
    refused: null,
    tamper(gate) {
      fs.writeFileSync(path.join(gate.workspace, "scripts", "package.json"), selfReferencing());
      fs.writeFileSync(path.join(gate.workspace, "scripts", "neutralised.mjs"), neutralisedModule(installedIndex(gate)));
    },
  },
  "renames the package.json of the workspace to ai-sdlc-factory, so that the package finds itself before any node_modules": {
    refused: null,
    tamper(gate) {
      const file = path.join(gate.workspace, "package.json");
      const own = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : { name: "example-orchestrator", private: true };
      fs.writeFileSync(file, `${JSON.stringify({ ...own, ...JSON.parse(selfReferencing()) }, null, 2)}\n`);
      fs.writeFileSync(path.join(gate.workspace, "neutralised.mjs"), neutralisedModule(installedIndex(gate)));
    },
  },
};

for (const key of STAGED_KEYS) {
  const { frontmatter } = driftWorkflow(key);
  const prepareStep = stepWith(frontmatter["pre-agent-steps"], "drift/prepare-run.mjs");
  const [validator] = frontmatter["post-steps"];
  const targetGate = () => createGateWorkspace({ checkoutName: CHECKOUT, files: targetFiles(), ownSource: true });
  const FAILURE = /scripts\/validate-example\.mjs is not the copy that prepare-run made before the agent started|src\/drift\/lib is not the copy that prepare-run made before the agent started/;

  test(`AC22: drift-${key}: with the steps of a job in order and an agent that changes nothing of the validator, the gate runs it and passes`, { skip: BASH_SKIP }, async () => {
    const gate = targetGate();
    try {
      gate.exported = {};
      assert.equal((await gate.runSteps([prepareStep])).code, 0);
      const finished = await gate.runSteps([validator]);
      assert.equal(finished.code, 0, finished.log);
      assert.match(finished.output, /validate-example: reports\/(?:audit|improvement)-report\.md is valid/, "the validator ran, after a comparison that said nothing");
      assert.equal(FAILURE_TEXT.test(finished.output), false);
    } finally {
      gate.cleanup();
    }
  });

  test(`AC22: drift-${key}: an agent that rewrites the declared validator so that it always passes, and invalidates the target report, fails the gate with exit 1`, { skip: BASH_SKIP }, async () => {
    const gate = targetGate();
    try {
      gate.exported = {};
      assert.equal((await gate.runSteps([prepareStep])).code, 0);
      // the agent step
      agentWrites(gate, VALIDATOR, ALWAYS_PASSES);
      invalidateAndCommit(gate, key);
      const finished = await gate.runSteps([validator]);
      assert.equal(finished.code, 1, finished.log);
      assert.ok(finished.output.includes(`${VALIDATOR} is not the copy that prepare-run made before the agent started`), finished.log);
      assert.equal(finished.output.includes("validate-example:"), false, "the rewritten validator did not run: the missing section is not what stopped the gate");
      // The control: the bare validator lets the same rewrite and invalid report through without the comparison.
      const bare = { name: "the validator alone", run: `node "$GITHUB_WORKSPACE/${VALIDATOR}"${key === "agent-kit" ? " --self-improve" : ""}`, "working-directory": CHECKOUT };
      const passes = await gate.runSteps([bare]);
      assert.equal(passes.code, 0, `without the comparison the rewritten validator passes an invalid report: ${passes.log}`);
    } finally {
      gate.cleanup();
    }
  });

  test(`AC22: drift-${key}: an agent that changes, adds or deletes a module of src/drift/lib/ that the validator imports fails the gate with exit 1`, { skip: BASH_SKIP }, async () => {
    const tampers = {
      "changes cli.mjs": (gate) => agentWrites(gate, `${FACTORY_DIR}/src/drift/lib/cli.mjs`, `${fs.readFileSync(path.join(gate.workspace, FACTORY_DIR, "src", "drift", "lib", "cli.mjs"), "utf8")}\n// changed by the agent\n`),
      "replaces args.mjs": (gate) => agentWrites(gate, `${FACTORY_DIR}/src/drift/lib/args.mjs`, "export class UsageError extends Error {}\nexport const parseFlags = () => ({});\n"),
      "deletes args.mjs": (gate) => fs.rmSync(path.join(gate.workspace, FACTORY_DIR, "src", "drift", "lib", "args.mjs")),
      "adds a module": (gate) => agentWrites(gate, `${FACTORY_DIR}/src/drift/lib/added-by-the-agent.mjs`, "export {};\n"),
    };
    for (const [name, tamper] of Object.entries(tampers)) {
      const gate = targetGate();
      try {
        gate.exported = {};
        assert.equal((await gate.runSteps([prepareStep])).code, 0);
        tamper(gate);
        const finished = await gate.runSteps([validator]);
        assert.equal(finished.code, 1, `${name}\n${finished.log}`);
        assert.ok(finished.output.includes("src/drift/lib is not the copy that prepare-run made before the agent started"), `${name}\n${finished.log}`);
      } finally {
        gate.cleanup();
      }
    }
  });

  for (const [name, { refused, tamper }] of Object.entries(RESOLUTION_TAMPERS)) {
    test(`AC22: drift-${key}: an agent that ${name} fails the gate with exit 1, and the validator of the workspace alone would have let an invalid report pass`, { skip: BASH_SKIP }, async () => {
      const gate = targetGate();
      try {
        gate.exported = {};
        assert.equal((await gate.runSteps([prepareStep])).code, 0);
        // the agent step
        tamper(gate);
        if (refused === null) {
          // Nothing of the change is compared, because the gate does not run the workspace copy: with a valid report the staged validator passes it on its own word.
          const valid = await gate.runSteps([validator]);
          assert.equal(valid.code, 0, valid.log);
          assert.match(valid.output, /validate-example: reports\/(?:audit|improvement)-report\.md is valid/, "the validator that ran is the real one");
          assert.equal(valid.output.includes(NEUTRALISED), false, "the agent's module did not run");
        }
        invalidateAndCommit(gate, key);
        const finished = await gate.runSteps([validator]);
        assert.equal(finished.code, 1, finished.log);
        if (refused === null) assert.ok(finished.output.includes(VALIDATOR_VERDICT[key]), `the staged validator ran, and its own verdict is what stopped the gate: ${finished.log}`);
        else assert.ok(finished.output.includes(`${refused} is not the copy that prepare-run made before the agent started`), finished.log);
        assert.equal(finished.output.includes(NEUTRALISED), false, "the agent's module did not run");
        // The control: the validator of the workspace alone, with the same change and the same invalid report, runs the agent's module and passes. That is what the gate is for.
        const bare = { name: "the validator alone", run: `node "$GITHUB_WORKSPACE/${VALIDATOR}"${key === "agent-kit" ? " --self-improve" : ""}`, "working-directory": CHECKOUT };
        const passes = await gate.runSteps([bare]);
        assert.equal(passes.code, 0, `without the gate the agent's module judges the report: ${passes.log}`);
        assert.ok(passes.output.includes(NEUTRALISED), passes.log);
      } finally {
        gate.cleanup();
      }
    });
  }

  test(`AC22: drift-${key}: a missing staged copy, or no RUNNER_TEMP, is a failed gate and not a skipped one`, { skip: BASH_SKIP }, async () => {
    const gate = targetGate();
    try {
      forceRemove(path.join(gate.runnerTemp, "gh-aw"));
      const missing = await gate.runSteps([validator]);
      assert.equal(missing.code, 1, missing.log);
      assert.match(missing.output, FAILURE);
      const unset = await gate.runSteps([validator], { env: { RUNNER_TEMP: "" } });
      assert.equal(unset.code, 1, unset.log);
      assert.match(unset.output, /RUNNER_TEMP is not set/);
    } finally {
      gate.cleanup();
    }
  });
}

test("AC22: after the comparison passes, a missing required report section fails with the neutral validator's own message", { skip: BASH_SKIP }, async () => {
  const { frontmatter } = driftWorkflow("lab-content");
  const gate = createGateWorkspace({ checkoutName: CHECKOUT, files: targetFiles(), ownSource: true });
  try {
    gate.exported = {};
    assert.equal((await gate.runSteps([stepWith(frontmatter["pre-agent-steps"], "drift/prepare-run.mjs")])).code, 0);
    invalidateAndCommit(gate, "lab-content");
    const finished = await gate.runSteps([frontmatter["post-steps"][0]]);
    assert.equal(finished.code, 1, finished.log);
    assert.ok(finished.output.includes("validate-example: reports/audit-report.md has no '## Verification' section"), finished.log);
    assert.equal(FAILURE_TEXT.test(finished.output), false, "the comparison passed: the validator it ran is the staged one");
  } finally {
    gate.cleanup();
  }
});

const FAILURE_TEXT = /is not the copy that prepare-run made/;
