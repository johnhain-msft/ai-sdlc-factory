// AC40-AC42: src/verify-immutable-gates.mjs, the JSON it prints and the exit codes it ends with, check (i) (zero diff on the locked paths) and check (ii) (zero
// diff on the test files that another workflow owns). Every run is the real command under `node --frozen-intrinsics` against a git fixture.
import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { commitAll, git, readText, tempDir, writeFiles, HELPERS } from "./helpers/fixtures.mjs";
import { gateManifest } from "./helpers/gate-fleet.mjs";
import { WORKFLOWS, edgeOf, read, runGates, scenario, shown } from "./helpers/gates.mjs";

const LOCKED = edgeOf("gadget-lessons").immutableGates.zeroDiffPaths;
/** The file that a test changes for a zero-diff entry: the entry itself, or a file inside a directory entry. */
const FILE_OF = { kernel: "kernel/boot.ts" };
const fileFor = (entry) => FILE_OF[entry] ?? entry;
const append = (dir, relative) => ({ [relative]: `${read(dir, relative)}\n// changed\n` });

test("AC40: an unmodified tree is ok: one JSON object { status: ok, violatingFiles: [] } on standard output and exit 0", () => {
  for (const workflow of WORKFLOWS) {
    const result = scenario({ workflow }).run();
    assert.equal(result.code, 0, `${workflow}: ${shown(result)}`);
    assert.deepEqual(result.json, { status: "ok", violatingFiles: [] }, workflow);
    assert.equal(result.stdout.trim().split("\n").length, 1, "exactly one line of JSON");
  }
});

for (const entry of LOCKED) {
  test(`AC41: a change to ${entry} makes the command exit 1 and names exactly that file`, () => {
    const file = fileFor(entry);
    const result = scenario({ mutate: (dir) => append(dir, file) }).run();
    assert.equal(result.code, 1, shown(result));
    assert.deepEqual(result.json, { status: "violation", violatingFiles: [file] });
  });
}

test("AC41: a locked path that is deleted, added, renamed, changed only in the work tree or in the index, or left untracked is a violation, and so is a new file in a locked directory", () => {
  const deleted = scenario({ mutate: () => ({ "kernel/boot.ts": null }) }).run();
  assert.deepEqual(deleted.json, { status: "violation", violatingFiles: ["kernel/boot.ts"] }, shown(deleted));
  const added = scenario({ mutate: () => ({ "kernel/extra.ts": "export const x = 1;\n" }) }).run();
  assert.deepEqual(added.json, { status: "violation", violatingFiles: ["kernel/extra.ts"] });
  const renamed = scenario({ mutate: (dir) => ({ "kernel/boot-renamed.ts": read(dir, "kernel/boot.ts"), "kernel/boot.ts": null }) }).run();
  assert.deepEqual(renamed.json.violatingFiles, ["kernel/boot-renamed.ts", "kernel/boot.ts"], "a rename lists both paths");
  const dirty = scenario({ mutate: (dir) => append(dir, "kernel/limits.ts"), commit: false }).run();
  assert.deepEqual(dirty.json, { status: "violation", violatingFiles: ["kernel/limits.ts"] }, "an uncommitted edit is the agent's edit too");
  const untracked = scenario({ mutate: () => ({ "kernel/scratch.mjs": "export {};\n" }), commit: false }).run();
  assert.deepEqual(untracked.json.violatingFiles, ["kernel/scratch.mjs"], "an untracked file in a locked directory");
  const staged = scenario();
  writeFiles(staged.dir, append(staged.dir, "ops/deploy.sh"));
  git(staged.dir, ["add", "-A"]);
  assert.deepEqual(staged.run().json.violatingFiles, ["ops/deploy.sh"], "a staged edit");
});

test("AC41: a locked path that the diff touches in several ways is listed once, with every locked file sorted", () => {
  const checked = scenario({ mutate: (dir) => ({ ...append(dir, "kernel/boot.ts"), ...append(dir, "ops/deploy.sh"), "kernel/extra.ts": "export {};\n" }) });
  writeFiles(checked.dir, append(checked.dir, "kernel/boot.ts"));
  const result = checked.run();
  assert.deepEqual(result.json.violatingFiles, ["kernel/boot.ts", "kernel/extra.ts", "ops/deploy.sh"]);
  assert.equal(result.code, 1);
});

const SIBLING_EDGES = ["gadget-lessons", "gadget-views", "gadget-docs"];
for (const edgeId of SIBLING_EDGES) {
  const workflow = `cascade-ai-${edgeId}`;
  test(`AC42: for ${workflow}, editing a sibling test file exits 1 with that file listed; editing the workflow's own test file does not trigger check (ii)`, () => {
    const manifest = gateManifest();
    const original = manifest.dependencyEdges[0];
    const fileOf = (id) => id === original.edgeId ? "checks/site.test.ts" : `checks/${id}.test.ts`;
    manifest.dependencyEdges = SIBLING_EDGES.map((id) => ({
      ...structuredClone(original),
      edgeId: id,
      upstreamRepo: `${original.upstreamRepo.split("/")[0]}/${id}`,
      upstreamKey: id,
      upstreamSlug: id.replaceAll("-", "_").toUpperCase(),
      stateVariable: `SDLC_SYNC_STATE_${id.replaceAll("-", "_").toUpperCase()}`,
      branchName: `sdlc/cascade-${id}`,
      closeOlderKey: `sdlc-cascade-${id}`,
      allowedFiles: [...original.allowedFiles.filter((file) => file !== "checks/site.test.ts"), fileOf(id)],
      immutableGates: {
        ...structuredClone(original.immutableGates),
        lockedTestBlocks: [{ ...structuredClone(original.immutableGates.lockedTestBlocks[0]), file: fileOf(id) }],
      },
    }));
    const prepare = (dir) => Object.fromEntries(SIBLING_EDGES.filter((id) => id !== original.edgeId).map((id) => [fileOf(id), read(dir, "checks/site.test.ts")]));
    for (const sibling of SIBLING_EDGES.filter((id) => id !== edgeId).map(fileOf)) {
      const result = scenario({ workflow, manifest, prepare, mutate: (dir) => append(dir, sibling) }).run();
      assert.equal(result.code, 1, `${sibling}: ${shown(result)}`);
      assert.deepEqual(result.json.violatingFiles, [sibling]);
      assert.match(result.stderr, /check \(ii\)/);
    }
    const own = fileOf(edgeId);
    const harmless = scenario({
      workflow,
      manifest,
      prepare,
      mutate: (dir) => ({ [own]: `${read(dir, own).replace(/\s*$/, "")}\n\n// a note for the next editor\n` }),
    }).run();
    assert.equal(harmless.code, 0, `${own}: ${shown(harmless)}`);
  });
}

test("AC40: exit 2 with no JSON for an unknown workflow, malformed or absent base, missing flag, or invalid downstream checkout", () => {
  const { dir, base } = scenario();
  const cases = [
    ["unknown workflow", ["--downstream", dir, "--base", base, "--workflow", "cascade-ai-nope"]],
    ["a mechanical workflow is not an AI workflow", ["--downstream", dir, "--base", base, "--workflow", "cascade-mechanical-gadget-lessons"]],
    ["short base", ["--downstream", dir, "--base", base.slice(0, 7), "--workflow", WORKFLOWS[0]]],
    ["uppercase base", ["--downstream", dir, "--base", base.toUpperCase(), "--workflow", WORKFLOWS[0]]],
    ["a base that is no commit", ["--downstream", dir, "--base", "d".repeat(40), "--workflow", WORKFLOWS[0]]],
    ["no --workflow", ["--downstream", dir, "--base", base]],
    ["no --downstream", ["--base", base, "--workflow", WORKFLOWS[0]]],
    ["a downstream that is no git checkout", ["--downstream", tempDir("sdlc-s4-plain-"), "--base", base, "--workflow", WORKFLOWS[0]]],
    ["a subdirectory is not the checkout root", ["--downstream", path.join(dir, "kernel"), "--base", base, "--workflow", WORKFLOWS[0]]],
    ["an unknown option", ["--downstream", dir, "--base", base, "--workflow", WORKFLOWS[0], "--fast"]],
  ];
  for (const [label, args] of cases) {
    const result = runGates(dir, base, WORKFLOWS[0], { args });
    assert.equal(result.code, 2, `${label}: ${shown(result)}`);
    assert.equal(result.json, null, `${label}: no JSON on a fatal error`);
    assert.match(result.stderr, /verify-immutable-gates:/);
  }
});

test("AC40: the command is not run from a directory that has no sdlc.yaml unless GITHUB_WORKSPACE names the orchestrator checkout, and a downstream sdlc.yaml is never the policy", () => {
  const { dir, base, workspace } = scenario({ mutate: (d) => append(d, "kernel/boot.ts") });
  const elsewhere = tempDir("sdlc-s4-cwd-");
  assert.equal(runGates(dir, base, WORKFLOWS[0], { cwd: elsewhere }).code, 2, "no policy at all is fatal, never a pass");
  const viaWorkspace = runGates(dir, base, WORKFLOWS[0], { cwd: elsewhere, env: { GITHUB_WORKSPACE: workspace } });
  assert.deepEqual(viaWorkspace.json, { status: "violation", violatingFiles: ["kernel/boot.ts"] }, shown(viaWorkspace));
  // an agent that adds a manifest with no locked paths to the downstream checkout gains nothing
  writeFiles(dir, { "sdlc.yaml": "projects: []\ndependencyEdges: []\n" });
  commitAll(dir, "an agent's manifest");
  const shadow = runGates(dir, base, WORKFLOWS[0], { cwd: dir, env: { GITHUB_WORKSPACE: workspace } });
  assert.equal(shadow.json.status, "violation", shown(shadow));
  assert.ok(shadow.json.violatingFiles.includes("kernel/boot.ts"));
});

test("AC40: a command run by a person without the frozen-intrinsics flag still decides check (i)-(iii), but refuses to run check (iv)", () => {
  const clean = scenario();
  const unfrozen = runGates(clean.dir, clean.base, WORKFLOWS[0], { frozen: false });
  assert.equal(unfrozen.code, 2, shown(unfrozen));
  assert.match(unfrozen.stderr, /frozen-intrinsics/);
  const violated = scenario({ mutate: (dir) => append(dir, "kernel/boot.ts") });
  assert.equal(runGates(violated.dir, violated.base, WORKFLOWS[0], { frozen: false }).code, 1, "a violation found before check (iv) needs no frozen process");
});

test("AC1: the helper names no repository and completes against the neutral fleet with its own paths, titles and invariants", () => {
  const checked = scenario({ mutate: () => ({ "web/pages/p1.ts": "export const p1 = { lines: ['a calm first page', 'and a second line'] };\n" }) });
  const helper = readText(HELPERS.gates);
  for (const edge of gateManifest().dependencyEdges) {
    assert.equal(helper.includes(edge.upstreamRepo), false);
    assert.equal(helper.includes(edge.downstreamRepo), false);
  }
  const result = checked.run();
  assert.equal(result.code, 0, shown(result));
  assert.deepEqual(JSON.parse(result.stdout), { status: "ok", violatingFiles: [] });
  writeFiles(checked.dir, { "kernel/boot.ts": "export const boot = 2;\n" });
  commitAll(checked.dir, "a locked change");
  const locked = checked.run();
  assert.equal(locked.code, 1, shown(locked));
  assert.deepEqual(JSON.parse(locked.stdout), { status: "violation", violatingFiles: ["kernel/boot.ts"] });
});

test("AC40: the deprecated --portfolio alias keeps the same decision and warns; giving it with --downstream is a usage error", () => {
  const checked = scenario();
  const canonical = checked.run();
  const flags = ["--base", checked.base, "--workflow", WORKFLOWS[0]];
  const legacy = checked.run({ args: ["--portfolio", checked.dir, ...flags] });
  assert.equal(canonical.code, 0, shown(canonical));
  assert.equal(legacy.code, canonical.code, shown(legacy));
  assert.deepEqual(legacy.json, canonical.json);
  assert.match(legacy.stderr, /--portfolio is deprecated; use --downstream/);
  assert.doesNotMatch(canonical.stderr, /deprecated/);
  const both = checked.run({ args: ["--portfolio", checked.dir, "--downstream", checked.dir, ...flags] });
  assert.equal(both.code, 2, shown(both));
  assert.equal(both.stdout, "");
  assert.match(both.stderr, /give one of them/);
});

test("AC47: only declared generatedPaths are exempt from the editable-module construct scan, with no built-in public exemption", () => {
  const file = "assets/generated.js";
  const source = "export const data = Object.assign({}, { generated: true });\n";
  const manifest = gateManifest();
  manifest.dependencyEdges[0].allowedFiles.push("assets/**", "public/**");
  const checked = scenario({ manifest, mutate: () => ({ [file]: source }) }).run();
  assert.equal(checked.code, 1, shown(checked));
  assert.deepEqual(checked.json.violatingFiles, [file]);
  assert.match(checked.stderr, /adds Object\.assign/);
  const generated = structuredClone(manifest);
  generated.dependencyEdges[0].immutableGates.generatedPaths = ["assets/**"];
  const exempt = scenario({ manifest: generated, mutate: () => ({ [file]: source }) });
  const result = exempt.run();
  assert.equal(result.code, 0, shown(result));
  assert.deepEqual(result.json, { status: "ok", violatingFiles: [] });
  assert.equal(read(exempt.dir, file), source, "the generated file was inspected, not rewritten");
  const publicFile = scenario({ manifest, mutate: () => ({ "public/generated.js": source }) }).run();
  assert.equal(publicFile.code, 1, shown(publicFile));
  assert.deepEqual(publicFile.json.violatingFiles, ["public/generated.js"]);
});
