// AC43 (disjoint writers), AC46, AC47, AC48 and AC52: allowed-files and the locked paths of the AI edges.
import assert from "node:assert/strict";
import test from "node:test";
import { buildAcks, renderFleet } from "../../src/reconcile.mjs";
import { abs, edgeOf, globMatches, mutate, parseWorkflow, PRESET_ROOT, presetManifest, readText, readWorkflow, referenceRequest, toYaml } from "./helpers/fixtures.mjs";
import { createWorkspace } from "./helpers/workspace.mjs";

const request = referenceRequest();
const preset = presetManifest();
const W = ".github/workflows";

const AI_EDGES = preset.dependencyEdges.filter((edge) => edge.mode === "ai-adaptation");
const CONTENT = edgeOf(preset, "lab-to-hub");
const RUNS = edgeOf(preset, "pipelines-to-hub");
const MECHANICAL = edgeOf(preset, "docs-to-hub");
const ZERO_DIFF = [...new Set(AI_EDGES.flatMap((edge) => edge.immutableGates.zeroDiffPaths))];

/** AC52 "includes": equal, beneath a directory entry, matched as a glob, or matched by it. */
function includes(pattern, locked) {
  const entry = locked.replace(/\/+$/, "");
  const candidate = pattern.replace(/\/+$/, "");
  return candidate === entry || candidate.startsWith(`${entry}/`) || globMatches(candidate, entry) || globMatches(entry, candidate);
}
const overlaps = (a, b) => includes(a, b) || includes(b, a);

test("AC46: the list is read from sdlc.yaml — editing the manifest changes the generated output", () => {
  const edited = mutate(preset, (copy) => edgeOf(copy, "lab-to-hub").allowedFiles.push("docs/extra-surface.md"));
  const workspace = createWorkspace({ manifestText: toYaml(edited), instructions: true });
  try {
    const result = renderFleet(request, { cwd: workspace.dir });
    assert.ok(result.ok, JSON.stringify(result.result));
    const handler = parseWorkflow(result.files.get(`${W}/cascade-ai-lab-to-hub.md`)).frontmatter["safe-outputs"]["create-pull-request"];
    assert.deepEqual(handler["allowed-files"], [...CONTENT.allowedFiles, "docs/extra-surface.md"]);
    assert.deepEqual(buildAcks(request, { cwd: workspace.dir }).ai.allowedFilesByWorkflow["cascade-ai-lab-to-hub"], [...CONTENT.allowedFiles, "docs/extra-surface.md"]);
  } finally {
    workspace.cleanup();
  }
});

test("AC47: none of the locked paths is included by any allowedFiles entry of any AI edge", () => {
  for (const { edgeId, allowedFiles: list } of AI_EDGES) {
    for (const locked of ZERO_DIFF) {
      for (const pattern of list) assert.equal(includes(pattern, locked), false, `${edgeId}: '${pattern}' includes locked '${locked}'`);
    }
  }
});

test("AC47: the content workflow's allowed-files contains none of the locked glob forms or sibling test files", () => {
  const allowed = readWorkflow("cascade-ai-lab-to-hub.md").frontmatter["safe-outputs"]["create-pull-request"]["allowed-files"];
  for (const excluded of [
    "content/*.ts",
    "kernel/**",
    "scripts/**",
    ...ZERO_DIFF,
    ...AI_EDGES.filter((edge) => edge.edgeId !== CONTENT.edgeId).flatMap((edge) => edge.allowedFiles.filter((entry) => entry.startsWith("tests/"))),
  ]) {
    assert.equal(allowed.includes(excluded), false, excluded);
  }
});

test("AC48: every cascade workflow sets allowed-files to its manifest list, in order", () => {
  const acks = buildAcks(request, { cwd: PRESET_ROOT }).ai.allowedFilesByWorkflow;
  for (const edge of preset.dependencyEdges) {
    const id = `cascade-${edge.mode === "mechanical" ? "mechanical" : "ai"}-${edge.edgeId}`;
    assert.deepEqual(readWorkflow(`${id}.md`).frontmatter["safe-outputs"]["create-pull-request"]["allowed-files"], edge.allowedFiles, id);
    if (edge.mode === "ai-adaptation") assert.deepEqual(acks[id], edge.allowedFiles, id);
  }
});

test("AC43/AC48: the allowed-files of cascade workflows are pairwise disjoint, so each surface has exactly one writer", () => {
  const acks = buildAcks(request, { cwd: PRESET_ROOT });
  const lists = Object.fromEntries(preset.dependencyEdges.map((edge) => {
    const id = `cascade-${edge.mode === "mechanical" ? "mechanical" : "ai"}-${edge.edgeId}`;
    return [id, edge.mode === "ai-adaptation" ? acks.ai.allowedFilesByWorkflow[id] : readWorkflow(`${id}.md`).frontmatter["safe-outputs"]["create-pull-request"]["allowed-files"]];
  }));
  assert.equal(Object.keys(lists).length, 6);
  const names = Object.keys(lists);
  for (let first = 0; first < names.length; first += 1) {
    for (let second = first + 1; second < names.length; second += 1) {
      for (const a of lists[names[first]]) {
        for (const b of lists[names[second]]) assert.equal(overlaps(a, b), false, `${names[first]} '${a}' overlaps ${names[second]} '${b}'`);
      }
    }
  }
});

test("AC48: the runs workflow is the sole writer of its surfaces", () => {
  const surfaces = RUNS.allowedFiles;
  const acks = buildAcks(request, { cwd: PRESET_ROOT }).ai.allowedFilesByWorkflow;
  for (const [workflow, list] of Object.entries(acks)) {
    if (workflow === `cascade-ai-${RUNS.edgeId}`) continue;
    for (const entry of list) assert.equal(surfaces.some((surface) => overlaps(entry, surface)), false, `${workflow}: ${entry}`);
  }
});

const MUTATIONS = [
  ["a glob over the locked rules file", "content/*.ts"],
  ["the locked rules file itself", "content/rules.ts"],
  ["the locked server entrypoint", "apps/site/server/src/index.ts"],
  ["the locked types file", "content/types.ts"],
  ["the sandbox test", "apps/site/server/tests/sandbox.test.ts"],
  ["a directory entry beneath the kernel", "kernel/**"],
  ["a file beneath the locked kernel directory", "kernel/helper.ts"],
  ["a file beneath the locked scripts directory", "scripts/build.mjs"],
  ["the locked server sandbox", "apps/site/server/src/sandbox.ts"],
  ["a recursive glob over the server sources", "apps/site/server/src/**"],
  ["a wildcard over the server tests", "apps/site/server/tests/*.ts"],
  ["a locked test file", "tests/login.test.ts"],
];

for (const [label, pattern] of MUTATIONS) {
  test(`AC52: adding ${label} (${pattern}) to the content allowedFiles returns status error and writes nothing`, async () => {
    const mutated = mutate(preset, (copy) => edgeOf(copy, CONTENT.edgeId).allowedFiles.push(pattern));
    const workspace = createWorkspace({ manifestText: toYaml(mutated), instructions: true });
    try {
      workspace.write(".github/workflows/ci.yml", "name: operator workflow\non: push\n");
      const before = workspace.hash();
      const result = await workspace.reconcile(request);
      assert.equal(result.status, "error");
      const errors = result.validationResults.flatMap((entry) => entry.errors);
      assert.ok(errors.some((error) => /^allowed-files-locked-path: /.test(error) && error.includes(`'${pattern}'`) && error.includes(`'${CONTENT.edgeId}'`)), errors.join("\n"));
      assert.equal(workspace.hash(), before, "no file is emitted");
      assert.equal(workspace.shims.compileCalls().length, 0);
    } finally {
      workspace.cleanup();
    }
  });
}

test("AC52: the locked set comes from the edge's own zeroDiffPaths — the same pattern is fine when the edge locks nothing", () => {
  const relaxed = mutate(preset, (copy) => {
    const edge = edgeOf(copy, MECHANICAL.edgeId);
    edge.allowedFiles.push("src/**");
  });
  const workspace = createWorkspace({ manifestText: toYaml(relaxed), instructions: true });
  try {
    const result = renderFleet(request, { cwd: workspace.dir });
    assert.ok(result.ok, "the mechanical edge has no zeroDiffPaths, so src/** is its own business");
  } finally {
    workspace.cleanup();
  }
  const customLock = mutate(preset, (copy) => {
    const edge = edgeOf(copy, MECHANICAL.edgeId);
    edge.immutableGates.zeroDiffPaths = ["public/docs/schema"];
  });
  const second = createWorkspace({ manifestText: toYaml(customLock), instructions: true });
  try {
    const result = renderFleet(request, { cwd: second.dir });
    assert.equal(result.ok, false);
    assert.ok(result.result.validationResults.flatMap((entry) => entry.errors).some((error) => error.startsWith("allowed-files-locked-path: ")));
  } finally {
    second.cleanup();
  }
});

test("AC52: the engine names none of the locked paths in its own code", () => {
  const source = readText(abs("src", "reconcile.mjs"));
  assert.equal(/rules\.ts|sandbox\.test\.ts/.test(source), false);
  for (const locked of ZERO_DIFF.filter((entry) => entry.includes("/"))) assert.equal(source.includes(locked), false, locked);
});
