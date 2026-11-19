// The install block under the real gh-aw compiler (design section C.5): both forms of the block compile under `gh aw compile --strict`, and a token step
// without an explicit `repositories` input is rejected, which is why the renderer always sets it. Compile cases require SDLC_REAL_GH_AW=1; preflight cases always run.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import YAML from "yaml";
import { assertGhAwAtLeast, compileStrict, SKIP_REAL_GH_AW } from "./helpers/real-gh-aw.mjs";
import { bodyOf, frontmatterOf, workflowsOf } from "./helpers/rendered.mjs";
import { checkRendered, reconcile, renderFleet } from "../src/reconcile.mjs";
import { createWorkspace, miniManifest, referenceRequest } from "./helpers/mini-fleet.mjs";

const ACTIONS_LOCK = fs.readFileSync(fileURLToPath(new URL("./fixtures/actions-lock.json", import.meta.url)), "utf8");
const FACTORY = { package: "ai-sdlc-factory", source: "github:example-org/ai-sdlc-factory", private: true };

function render(t, block) {
  const work = createWorkspace(t, { mutate: (manifest) => void (manifest.factory = structuredClone(block)) });
  const result = renderFleet(referenceRequest(), { cwd: work.dir });
  assert.equal(result.ok, true, JSON.stringify(result.result));
  return result.files;
}

const invalid = (outcome) => outcome.results.filter((entry) => entry.valid !== true);

for (const [input, message] of [
  ["repositories", /factory-token-shape: .*names no repositories/],
  ["permission-contents", /factory-token-shape: .*permission-contents: read and no other permission/],
]) {
  test(`preflight: a factory token without ${input} is rejected`, (t) => {
    const files = render(t, FACTORY);
    const file = ".github/workflows/drift-docs-site.md";
    const fm = frontmatterOf(files.get(file));
    const token = fm["pre-agent-steps"].find((step) => step.id === "factory_token");
    delete token.with[input];
    const mutated = new Map(files).set(file, `---\n${YAML.stringify(fm, { lineWidth: 0 })}---\n\n${bodyOf(files.get(file))}\n`);
    const flagged = checkRendered(mutated, referenceRequest(), miniManifest()).filter((entry) => !entry.valid);
    assert.deepEqual(flagged.map((entry) => entry.file), [file]);
    assert.match(flagged[0].errors.join("\n"), message);
  });
}

test("reconcile() end to end: render, compile --strict --purge and write the lock files, for a private and a public factory", { skip: SKIP_REAL_GH_AW }, async (t) => {
  assertGhAwAtLeast("1.0.1");
  for (const block of [FACTORY, { ...FACTORY, private: false }]) {
    const work = createWorkspace(t, { mutate: (manifest) => void (manifest.factory = structuredClone(block)), files: { ".github/aw/actions-lock.json": ACTIONS_LOCK } });
    assert.equal(spawnSync("git", ["init", "-q"], { cwd: work.dir, windowsHide: true }).status, 0);
    const result = await reconcile(referenceRequest(), { cwd: work.dir, env: process.env });
    assert.equal(result.status, "ok", JSON.stringify(result.validationResults));
    assert.equal(result.generatedWorkflows.length, 7);
    for (const { lockYml } of result.generatedWorkflows) assert.ok(fs.existsSync(path.join(work.dir, lockYml)), lockYml);
    const lock = fs.readFileSync(path.join(work.dir, ".github", "workflows", "drift-docs-site.lock.yml"), "utf8");
    // the compiled agent job keeps the install block, and the token action of the factory is pinned by its commit (that pin exists in this lock only for a private factory)
    assert.equal(lock.includes("GIT_CONFIG_COUNT: \"3\""), block.private, "the git rewrites are in the compiled lock exactly when the factory is private");
    assert.equal(lock.includes("steps.factory_token.outputs.token"), block.private);
    assert.equal(/actions\/create-github-app-token@fee1f7d63c2ff003460e3d139729b119787bc349 # v2/.test(lock), block.private);
    assert.equal(lock.includes('run: node "$GITHUB_WORKSPACE/node_modules/ai-sdlc-factory/src/drift/prepare-run.mjs"'), true);
  }
});

test("private: all workflows compile under gh aw compile --strict", { skip: SKIP_REAL_GH_AW }, (t) => {
  assertGhAwAtLeast("1.0.1");
  const outcome = compileStrict(t, render(t, FACTORY), { actionsLock: ACTIONS_LOCK });
  assert.equal(outcome.results.length, 7, outcome.stderr);
  assert.deepEqual(invalid(outcome), []);
  assert.equal(outcome.code, 0, outcome.stderr);
});

test("public: all workflows compile under gh aw compile --strict", { skip: SKIP_REAL_GH_AW }, (t) => {
  assertGhAwAtLeast("1.0.1");
  const outcome = compileStrict(t, render(t, { ...FACTORY, private: false }), { actionsLock: ACTIONS_LOCK });
  assert.equal(outcome.results.length, 7, outcome.stderr);
  assert.deepEqual(invalid(outcome), []);
  assert.equal(outcome.code, 0, outcome.stderr);
});

test("negative control: a factory token step without repositories and permission inputs is rejected in strict mode", { skip: SKIP_REAL_GH_AW }, (t) => {
  assertGhAwAtLeast("1.0.1");
  const files = render(t, FACTORY);
  const stripped = new Map(files);
  let touched = 0;
  for (const workflow of workflowsOf(files)) {
    const fm = frontmatterOf(workflow.text);
    const steps = [...(fm["pre-agent-steps"] ?? []), ...Object.values(fm.jobs ?? {}).flatMap((job) => job.steps ?? [])];
    for (const step of steps.filter((entry) => entry.id === "factory_token")) {
      delete step.with.repositories;
      delete step.with["permission-contents"];
      touched += 1;
    }
    stripped.set(workflow.file, `---\n${YAML.stringify(fm, { lineWidth: 0, indent: 2, aliasDuplicateObjects: false, minContentWidth: 0 })}---\n\n${bodyOf(workflow.text)}\n`);
  }
  assert.equal(touched, 13, "the rendered fleet has 13 factory token steps outside the router (the mini fleet: 14 with it)");
  const outcome = compileStrict(t, stripped, { actionsLock: ACTIONS_LOCK });
  const rejected = invalid(outcome);
  // every workflow that installs the factory is refused; the onboarding workflow installs nothing
  assert.deepEqual(rejected.map((entry) => entry.workflow).sort(), ["cascade-ai-lab-to-hub.md", "cascade-mechanical-docs-to-hub.md", "drift-docs-site.md", "drift-lab-content.md", "implement-docs-site.md", "implement-lab-content.md"].sort());
  for (const entry of rejected) {
    assert.match(entry.errors.join("\n"), /strict mode: actions\/create-github-app-token in job "[a-z_]+" has no explicit repositories input/, entry.workflow);
  }
  assert.notEqual(outcome.code, 0);
});
