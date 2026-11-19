// tools/render-diff.mjs (design G): the harness that proves two renders of one fleet differ only by the classes that a change is allowed to make. Its acceptance
// (G.5) is shown here on examples/: the stages and their classes with the counts of the reference fleet, the self test of stage 0, the classes that cannot hide a
// change that is not their own, the CLI, and, under SDLC_REAL_GH_AW=1, the same at L2 on locks that the real compiler made.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import YAML from "yaml";
import { renderFleet } from "../src/reconcile.mjs";
import { canonical, CLASSES, diffRenders, formatReport, main, parseDocument, readRender, selfTest, STAGES, unifiedDiff } from "../tools/render-diff.mjs";
import { engineAbs } from "./helpers/preset.mjs";
import { assertGhAwAtLeast, SKIP_REAL_GH_AW } from "./helpers/real-gh-aw.mjs";

const W = ".github/workflows";
const read = (...parts) => fs.readFileSync(engineAbs("examples", ...parts), "utf8");
const request = JSON.parse(read("request.reference.json"));
const DOCS_SITE = `${W}/drift-docs-site.md`;

function tmpDir(t, prefix = "sdlc-render-diff-test-") {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** The scratch workspace of one variant of the reference fleet: without a factory block (the old shape), a public factory, or the private one that is committed. */
function instanceOf(dir, kind) {
  const manifest = YAML.parse(read("sdlc.yaml"));
  if (kind === "legacy") delete manifest.factory;
  else manifest.factory.private = kind === "private";
  fs.writeFileSync(path.join(dir, "sdlc.yaml"), YAML.stringify(manifest, { lineWidth: 0 }));
  fs.cpSync(engineAbs("examples", "instructions"), path.join(dir, "instructions"), { recursive: true });
  fs.copyFileSync(engineAbs("examples", "package.json"), path.join(dir, "package.json"));
}

let cached;
/** The three renders of the reference fleet (Maps of path to text), made once. */
function renders() {
  if (cached) return cached;
  cached = {};
  for (const kind of ["legacy", "public", "private"]) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sdlc-render-diff-test-"));
    try {
      instanceOf(dir, kind);
      const result = renderFleet(request, { cwd: dir });
      assert.equal(result.ok, true, JSON.stringify(result.result));
      cached[kind] = result.files;
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
  return cached;
}

const committedLocks = () => new Map(fs.readdirSync(engineAbs("examples", W)).filter((name) => name.endsWith(".lock.yml")).map((name) => [`${W}/${name}`, read(W, name)]));
const writeTree = (dir, files) => {
  for (const [rel, text] of files) {
    fs.mkdirSync(path.dirname(path.join(dir, ...rel.split("/"))), { recursive: true });
    fs.writeFileSync(path.join(dir, ...rel.split("/")), text);
  }
};
const table = (result) => Object.fromEntries(result.rows.map((row) => [row.id, [row.expected, row.applied]]));

/** A copy of `files` in which one workflow source is edited through its parsed frontmatter (the harness compares parsed documents, so the formatting is free). */
function edited(files, rel, change) {
  const doc = parseDocument(rel, files.get(rel));
  change(doc.value);
  return new Map(files).set(rel, `---\n${YAML.stringify(doc.value, { lineWidth: 0 })}---\n${doc.body}`);
}
const stepsOf = (value) => value["pre-agent-steps"];

// ---- stage 0: the harness itself (G.5.3) ---------------------------------------------------------------------------------------------------------

test("stage 0: every variant of the fleet is empty against itself, with no class at work, and the self test passes", () => {
  for (const [kind, files] of Object.entries(renders())) {
    const result = diffRenders({ before: files, after: files, stage: "0" });
    assert.equal(result.ok, true, kind);
    assert.deepEqual(result.rows, [], `${kind}: stage 0 allows no class`);
    assert.deepEqual(result.leftovers, []);
    const self = selfTest(files);
    assert.equal(self.ok, true, `${kind}: ${self.lines.join("; ")}`);
    assert.equal(self.lines.filter((line) => line.endsWith(": reported")).length, 3);
  }
});

test("stage 0: an extra step, a changed permissions entry, a swapped step order and a changed key order are each reported, with the line that changed", () => {
  const files = renders().legacy;
  const mutations = {
    "an extra step": [(fm) => stepsOf(fm).push({ run: "echo an extra step" }), /\+\s+"run": "echo an extra step"/],
    "a changed permissions entry": [(fm) => { const [key] = Object.keys(fm.permissions); fm.permissions[key] = fm.permissions[key] === "write" ? "read" : "write"; }, /"contents": "(read|write)"|"[a-z-]+": "(read|write)"/],
    "a swapped step order": [(fm) => { const steps = stepsOf(fm); [steps[0], steps[1]] = [steps[1], steps[0]]; }, /^[-+]/m],
    "a changed key order": [(fm) => { const step = stepsOf(fm).find((candidate) => candidate.name && candidate.run); stepsOf(fm)[stepsOf(fm).indexOf(step)] = Object.fromEntries(Object.entries(step).reverse()); }, /^[-+]/m],
  };
  for (const [label, [change, expected]] of Object.entries(mutations)) {
    const result = diffRenders({ before: files, after: edited(files, DOCS_SITE, change), stage: "0" });
    assert.equal(result.ok, false, label);
    assert.deepEqual(result.leftovers.map((entry) => entry.file), [DOCS_SITE], `${label}: only the edited file differs`);
    assert.match(result.leftovers[0].diff, expected, label);
  }
});

test("the document model: a source is its frontmatter and its body, a lock keeps its metadata line, and the comparison text counts key order", () => {
  const source = parseDocument(DOCS_SITE, renders().legacy.get(DOCS_SITE));
  assert.equal(source.kind, "workflow");
  assert.ok(source.body.length > 100 && Array.isArray(source.value["pre-agent-steps"]));
  const lock = parseDocument(`${W}/drift-docs-site.lock.yml`, read(W, "drift-docs-site.lock.yml"));
  assert.equal(lock.kind, "lock");
  assert.equal(lock.meta.compiler_version, "v1.0.1");
  assert.notEqual(canonical({ kind: "json", value: { a: 1, b: 2 } }), canonical({ kind: "json", value: { b: 2, a: 1 } }));
  const diff = unifiedDiff("x.yml", "a\nb\nc\nd\ne", "a\nb\nX\nd\ne");
  assert.equal(diff.changed, 2);
  assert.match(diff.text, /--- before\/x\.yml\n\+\+\+ after\/x\.yml\n@@ line 3 @@\n a\n b\n-c\n\+X\n d\n e/);
});

// ---- the stages and their classes on the reference fleet (G.5.1) ----------------------------------------------------------------------------------

test("the stages name the classes of the design, and each later stage allows everything of the earlier ones", () => {
  assert.deepEqual(CLASSES.map(([id]) => id), ["D1", "D2", "D3", "D4a", "D4b", "D5", "D6", "D7", "D8", "D9", "D10"]);
  assert.deepEqual(STAGES[0], []);
  assert.deepEqual(STAGES[1], ["D1", "D5", "D6", "D7", "D8", "D10"]);
  for (const id of STAGES[1]) assert.ok(STAGES["2a"].includes(id));
  assert.deepEqual(STAGES["2a"].filter((id) => !STAGES[1].includes(id)), ["D2", "D3", "D4a", "D9"]);
  assert.deepEqual(STAGES["2b"].filter((id) => !STAGES["2a"].includes(id)), ["D4b"]);
});

test("stage 1: the old shape against itself is empty, and none of its classes occurs", () => {
  const { legacy } = renders();
  const result = diffRenders({ before: legacy, after: legacy, stage: "1" });
  assert.equal(result.ok, true);
  assert.deepEqual(Object.keys(table(result)), STAGES[1]);
  for (const row of result.rows) assert.deepEqual([row.expected, row.applied], [0, 0], row.id);
});

test("stage 2a: the factory moves into node_modules without auth, and each class changes exactly as often as its pattern occurs", () => {
  const { legacy, public: publicFleet } = renders();
  const result = diffRenders({ before: legacy, after: publicFleet, stage: "2a" });
  assert.equal(result.ok, true, formatReport(result, { before: legacy.size, after: publicFleet.size }).join("\n"));
  // D8: in each of the 8 validator commands (the name and the run of the step, in 4 workflows) the three spellings of drift-lib and the whole clause of package.json move
  assert.deepEqual(table(result), {
    D1: [0, 0], D2: [49, 49], D3: [18, 18], D4a: [9, 9], D5: [0, 0], D6: [0, 0], D7: [4, 4], D8: [32, 32], D9: [1, 1], D10: [0, 0],
  });
  assert.equal(result.rows.every((row) => row.ok), true);
  assert.deepEqual(result.leftovers, []);
});

test("stage 2b: the private factory adds the auth, one token step for each place that installs the factory, and nothing else", () => {
  const { legacy, private: privateFleet } = renders();
  const result = diffRenders({ before: legacy, after: privateFleet, stage: "2b" });
  assert.equal(result.ok, true, formatReport(result, { before: legacy.size, after: privateFleet.size }).join("\n"));
  assert.deepEqual(table(result), {
    D1: [0, 0], D2: [49, 49], D3: [18, 18], D4a: [9, 9], D4b: [28, 28], D5: [0, 0], D6: [0, 0], D7: [4, 4], D8: [32, 32], D9: [1, 1], D10: [0, 0],
  });
  const tokens = [...privateFleet.values()].reduce((sum, text) => sum + (text.match(/id: factory_token/g) ?? []).length, 0);
  assert.equal(tokens, 28, "token steps added == factory install steps: the 19 of the plain jobs and the router, and the 9 that the agent jobs gained");
});

test("a stage allows only its own classes: the auth is not allowed at 2a, the relocation not at 1, and a public render is not a private one at 2b", () => {
  const { legacy, public: publicFleet, private: privateFleet } = renders();
  const auth = diffRenders({ before: legacy, after: privateFleet, stage: "2a" });
  assert.equal(auth.ok, false);
  assert.ok(auth.leftovers.length >= 13 && auth.leftovers.every((entry) => /factory_token|Install the factory|GIT_CONFIG/.test(entry.diff)), "the auth is left over in every workflow that installs the factory");
  const early = diffRenders({ before: legacy, after: publicFleet, stage: "1" });
  assert.equal(early.ok, false);
  assert.ok(early.leftovers.some((entry) => /node_modules\/ai-sdlc-factory/.test(entry.diff)));
  const missing = diffRenders({ before: legacy, after: publicFleet, stage: "2b" });
  assert.equal(missing.ok, false);
  assert.match(missing.problems.join("\n"), /D4b .*rewrote 0 time\(s\), but its pattern occurs 28 time\(s\)/);
  assert.match(missing.problems.join("\n"), /not a private factory/);
  assert.throws(() => diffRenders({ before: legacy, after: legacy, stage: "3" }), /unknown stage '3'/);
});

test("a class cannot hide a change that is not its own: another flag, a stray install step, a missing install, and an auth that asks for more are all left over", () => {
  const { legacy, public: publicFleet, private: privateFleet } = renders();
  const run = (files, stage = "2a") => diffRenders({ before: legacy, after: files, stage });
  const cases = [
    ["another flag in an engine command", publicFleet, (fm) => { const step = stepsOf(fm).find((candidate) => String(candidate.run).includes("prepare-run.mjs")); step.run = step.run.replace("--out /tmp/gh-aw/agent", "--out /tmp/gh-aw/other"); }, /\/tmp\/gh-aw\/other/],
    ["a stray install step in a custom job", publicFleet, (fm) => { const job = Object.values(fm.jobs ?? {}).find((candidate) => (candidate.steps ?? []).length > 0); job.steps.push({ run: "npm ci --ignore-scripts" }); }, /npm ci --ignore-scripts/],
    ["a missing install step in an agent job", publicFleet, (fm) => { fm["pre-agent-steps"].shift(); }, /^-\s+"run": "npm ci --ignore-scripts"/m],
  ];
  for (const [label, files, change, expected] of cases) {
    const result = run(edited(files, DOCS_SITE, change));
    assert.equal(result.ok, false, label);
    assert.match(result.leftovers.map((entry) => entry.diff).join("\n"), expected, label);
  }
  // an auth that asks for more, or does something else, is not factory auth, even when every site does the same: the sites then agree with each other, and only
  // the shape check refuses them
  const withAuth = (files, { token = () => {}, install = () => {} }) =>
    new Map(
      [...files].map(([rel, text]) => {
        if (!rel.endsWith(".md") && !rel.endsWith("cascade-router.yml")) return [rel, text];
        const doc = parseDocument(rel, text);
        const visit = (node) => {
          if (Array.isArray(node)) node.forEach(visit);
          else if (node !== null && typeof node === "object") {
            if (node.id === "factory_token") token(node);
            if (node.name === "Install the factory") install(node);
            Object.values(node).forEach(visit);
          }
        };
        visit(doc.value);
        return [rel, doc.kind === "workflow" ? `---\n${YAML.stringify(doc.value, { lineWidth: 0 })}---\n${doc.body}` : YAML.stringify(doc.value, { lineWidth: 0 })];
      }),
    );
  const widenings = {
    "a token that can write": { token: (step) => { step.with["permission-contents"] = "write"; }, expected: /"permission-contents": "write"/ },
    "a token with a second permission": { token: (step) => { step.with["permission-issues"] = "write"; }, expected: /"permission-issues": "write"/ },
    "a token for several repositories": { token: (step) => { step.with.repositories = "ai-sdlc-factory,another-repository"; }, expected: /ai-sdlc-factory,another-repository/ },
    "a token that the App action does not mint": { token: (step) => { step.uses = "actions/checkout@v4"; }, expected: /actions\/checkout@v4/ },
    "an install without the git rewrites": { install: (step) => { delete step.env.GIT_CONFIG_COUNT; }, expected: /GIT_CONFIG_KEY_0/ },
    "an install that runs something else": { install: (step) => { step.run = "npm install"; }, expected: /npm install/ },
  };
  for (const [label, { expected, ...change }] of Object.entries(widenings)) {
    const result = run(withAuth(privateFleet, change), "2b");
    assert.equal(result.ok, false, label);
    assert.ok(result.leftovers.length >= 13, `${label}: every workflow that installs the factory is left over`);
    assert.match(result.leftovers.map((entry) => entry.diff).join("\n"), expected, label);
    assert.equal(result.rows.find((row) => row.id === "D4b").applied, 0, `${label}: no site was taken for factory auth`);
  }
});

// ---- the classes of the old shape: D1, D5, D6, D7 -------------------------------------------------------------------------------------------------

/** The old shape of the render, made from the new one by taking each class's change out again: what an instance had before it moved to the factory. */
function oldShape(files) {
  const out = new Map();
  const counts = { D1: 0, D5: 0, D6: 0, D7: 0 };
  for (const [rel, text] of files) {
    const lines = text.split("\n").map((line) => {
      let next = line;
      if (next.includes("verify-immutable-gates.mjs") && next.includes("--downstream")) { counts.D5 += (next.match(/--downstream/g) ?? []).length; next = next.replaceAll("--downstream", "--portfolio"); }
      if (next.includes("dedupe-open-prs.mjs") && / --project \S+$/.test(next)) { counts.D6 += 1; next = next.replace(/ --project \S+$/, ""); }
      if (next.includes("prepare-run.mjs") && / --factory-dir \. --stage-scripts \S+/.test(next)) { counts.D7 += 1; next = next.replace(/ --factory-dir \. --stage-scripts \S+/, ""); }
      const moved = (next.match(/\$GITHUB_WORKSPACE\/scripts\/validate-example\.mjs/g) ?? []).length;
      if (moved > 0) { counts.D1 += moved; next = next.replaceAll("$GITHUB_WORKSPACE/scripts/validate-example.mjs", "$GITHUB_WORKSPACE/src/validate-example.mjs"); }
      return next;
    });
    out.set(rel, lines.join("\n"));
  }
  return { files: out, counts };
}

test("stage 1: an instance script that moved, the renamed flag, the dedupe project and the staging arguments are each explained, with the counts of the old shape", () => {
  const { legacy } = renders();
  const old = oldShape(legacy);
  assert.ok(Object.values(old.counts).every((count) => count > 0), JSON.stringify(old.counts));
  const result = diffRenders({ before: old.files, after: legacy, stage: "1", instanceScripts: ["validate-example.mjs"] });
  assert.equal(result.ok, true, formatReport(result, { before: old.files.size, after: legacy.size }).join("\n"));
  const rows = table(result);
  assert.deepEqual([rows.D1, rows.D5, rows.D6, rows.D7], [[old.counts.D1, old.counts.D1], [old.counts.D5, old.counts.D5], [old.counts.D6, old.counts.D6], [old.counts.D7, old.counts.D7]]);
  assert.deepEqual(rows.D8, [0, 0], "no relocation at stage 1");
  const unknown = diffRenders({ before: old.files, after: legacy, stage: "1" });
  assert.equal(unknown.ok, false, "without --instance-scripts the moved script is not explained");
  assert.match(unknown.leftovers.map((entry) => entry.diff).join("\n"), /scripts\/validate-example\.mjs/);
  const later = diffRenders({ before: old.files, after: renders().public, stage: "2a", instanceScripts: ["validate-example.mjs"] });
  assert.equal(later.ok, true, "the classes of stage 1 are still allowed at 2a, together with the relocation");
});

// ---- the validator comparison of an instance before the split: D1 (its own script) and D8 (the factory's drift-lib, its clauses and its run target) ----------------

const NOT_THE_COPY = 'is not the copy that prepare-run made before the agent started" >&2; exit 1; }; ';
const factoryPathOf = (dir) => `$GITHUB_WORKSPACE${dir === "." ? "" : `/${dir}`}`;
/** The clauses of a validator command that a render spells for a factory directory `dir` (`.` is the workspace itself): package.json, drift/lib, and the refusal of scripts/node_modules. */
const packageClause = (dir) => `cmp -s "$copy/${dir}/package.json" "${factoryPathOf(dir)}"/package.json || { echo "${dir}/package.json ${NOT_THE_COPY}`;
const libClause = (dir) => `diff -rq "$copy/${dir}/src/drift/lib" "${factoryPathOf(dir)}"/src/drift/lib >&2 || { echo "${dir}/src/drift/lib ${NOT_THE_COPY}`;
const REFUSAL = `! test -e "$GITHUB_WORKSPACE/scripts/node_modules" || { echo "scripts/node_modules ${NOT_THE_COPY}`;
/** What the command ends in: the staged copy of the validator, which the engine's render runs, and the workspace copy, which the stage-1 command of an instance ran. */
const STAGED_RUN = 'node "$copy/scripts/validate-example.mjs"';
const WORKSPACE_RUN = 'node "$GITHUB_WORKSPACE/scripts/validate-example.mjs"';

/**
 * A render whose validator command runs the workspace copy of the script, as the stage-1 command of an instance does: the staged run of the engine's own render, put
 * back. `count` is how many commands ran the staged copy (once in each validator command).
 */
function withWorkspaceRun(files) {
  let count = 0;
  const out = new Map();
  for (const [rel, text] of files) {
    count += text.split(STAGED_RUN).length - 1;
    out.set(rel, text.split(STAGED_RUN).join(WORKSPACE_RUN));
  }
  return { files: out, count };
}

/**
 * A render without the two clauses that a validator comparison gained, the package.json one and the refusal: the comparison as the engine rendered it before it had them.
 * `dir` is the factory directory that the render spells. The counts say how many of each it held (once in each validator command).
 */
function withoutClauses(files, dir) {
  const counts = { package: 0, refusal: 0 };
  const out = new Map();
  for (const [rel, text] of files) {
    let next = text;
    for (const [clause, key] of [[packageClause(dir), "package"], [REFUSAL, "refusal"]]) {
      counts[key] += next.split(clause).length - 1;
      next = next.split(clause).join("");
    }
    out.set(rel, next);
  }
  return { files: out, counts };
}

/**
 * The old shape of an instance whose repository held the factory's sources in its own src/, made from the stage-1 render by taking out what the move changed in the
 * validator comparison (the staged copy and the message of an instance script, the three spellings of drift-lib, the two clauses that it did not have yet: the
 * comparison of package.json and the refusal of scripts/node_modules, and the run of the staged copy, which was the workspace copy in src/), on top of what oldShape takes out.
 * `runs` is how many commands ran the staged copy, which D8 turns back into a run of the staged copy at 2a and 2b.
 */
function preSplitShape(files) {
  const workspaceRun = withWorkspaceRun(files);
  const bare = withoutClauses(workspaceRun.files, ".");
  const old = oldShape(bare.files);
  const counts = { ...old.counts, D8: bare.counts.package + bare.counts.refusal };
  const swaps = [
    ['"$copy/scripts/validate-example.mjs"', '"$copy/validate-example.mjs"', "D1"],
    ['"scripts/validate-example.mjs is not the copy', '"src/validate-example.mjs is not the copy', "D1"],
    ['"$copy/./src/drift/lib"', '"$copy/drift/lib"', "D8"],
    ['"$GITHUB_WORKSPACE"/src/drift/lib', '"$GITHUB_WORKSPACE/src/drift/lib"', "D8"],
    ['"./src/drift/lib is not the copy', '"src/drift/lib is not the copy', "D8"],
  ];
  const out = new Map();
  for (const [rel, text] of old.files) {
    let next = text;
    for (const [from, to, key] of swaps) {
      const found = next.split(from).length - 1;
      if (found > 0) {
        counts[key] += found;
        next = next.split(from).join(to);
      }
    }
    out.set(rel, next);
  }
  return { files: out, counts, base: old.counts, clauses: bare.counts, runs: workspaceRun.count };
}

test("stage 1: the validator comparison of an instance before the split is explained: the staged copy and the message of its own script, the three spellings of drift-lib, and the two clauses that it lacked; the run stays the workspace copy", () => {
  const { legacy } = renders();
  const pre = preSplitShape(legacy);
  const stageOne = withWorkspaceRun(legacy).files;
  assert.ok(pre.counts.D8 > 0, "the old shape has drift-lib spellings to explain");
  assert.ok(pre.counts.D1 > pre.base.D1, "and staged copies and messages of the instance script, besides its workspace paths");
  assert.ok(pre.clauses.package > 0 && pre.clauses.refusal === pre.clauses.package, "and neither the package.json comparison nor the refusal of scripts/node_modules, in each validator command");
  assert.equal(pre.runs, pre.clauses.package, "and it runs the workspace copy of the script, from src/, in each validator command");
  assert.equal(pre.counts.D8, 3 * pre.clauses.package + pre.clauses.package + pre.clauses.refusal, "D8 of the old shape: three spellings and the two clauses of each validator command");
  const result = diffRenders({ before: pre.files, after: stageOne, stage: "1", instanceScripts: ["validate-example.mjs"] });
  assert.equal(result.ok, true, formatReport(result, { before: pre.files.size, after: stageOne.size }).join("\n"));
  assert.deepEqual(result.leftovers, []);
  const rows = table(result);
  assert.deepEqual(rows.D1, [pre.counts.D1, pre.counts.D1]);
  assert.deepEqual(rows.D8, [pre.counts.D8, pre.counts.D8], "at stage 1 the run is not D8's: D1 moves the script, and the workspace copy is still what runs");
});

test("stages 2a and 2b: the same old shape moves the factory into node_modules, the quoted drift-lib path is D8's, not a factory-script path of D2, and the run becomes the staged copy", () => {
  const { legacy, public: publicFleet, private: privateFleet } = renders();
  const pre = preSplitShape(legacy);
  const baseline = table(diffRenders({ before: oldShape(legacy).files, after: publicFleet, stage: "2a", instanceScripts: ["validate-example.mjs"] }));
  for (const [stage, after] of [["2a", publicFleet], ["2b", privateFleet]]) {
    const result = diffRenders({ before: pre.files, after, stage, instanceScripts: ["validate-example.mjs"] });
    assert.equal(result.ok, true, `${stage}: ${formatReport(result, { before: pre.files.size, after: after.size }).join("\n")}`);
    assert.deepEqual(result.leftovers, [], stage);
    const rows = table(result);
    assert.deepEqual(rows.D1, [pre.counts.D1, pre.counts.D1], `${stage}: the instance script, in its paths and in the run, which D1 moves to scripts/ before D8 turns it into the staged copy`);
    assert.deepEqual(rows.D8, [pre.counts.D8 + pre.runs, pre.counts.D8 + pre.runs], `${stage}: drift-lib, the two clauses and the run of the staged copy`);
    assert.deepEqual(rows.D2, baseline.D2, `${stage}: the same factory-script paths as before, with the quoted drift-lib path left to D8`);
  }
});

test("stages 1, 2a and 2b: the stage-1 command of an instance before the two clauses is explained: each missing clause is added, and at 2a and 2b the spellings of drift-lib move with the factory and the run becomes the staged copy", () => {
  const { legacy, public: publicFleet, private: privateFleet } = renders();
  const stageOne = withWorkspaceRun(legacy);
  const bare = withoutClauses(stageOne.files, ".");
  const commands = bare.counts.package;
  assert.ok(commands > 0 && bare.counts.refusal === commands && stageOne.count === commands, "the render has the two clauses and the staged run once in each validator command");
  for (const [stage, after, moved, run] of [["1", stageOne.files, 0, 0], ["2a", publicFleet, 3, 1], ["2b", privateFleet, 3, 1]]) {
    const result = diffRenders({ before: bare.files, after, stage });
    assert.equal(result.ok, true, `${stage}: ${formatReport(result, { before: bare.files.size, after: after.size }).join("\n")}`);
    assert.deepEqual(result.leftovers, [], stage);
    const expected = (2 + moved + run) * commands;
    assert.deepEqual(table(result).D8, [expected, expected], `${stage}: two clauses added to each command, ${moved} spellings of drift-lib moved and ${run} run turned into the staged copy`);
  }
});

test("stages 2a and 2b: the stage-1 command with both clauses, which still runs the workspace copy, moves with the factory and runs the staged copy", () => {
  const { legacy, public: publicFleet, private: privateFleet } = renders();
  const stageOne = withWorkspaceRun(legacy);
  const commands = stageOne.count;
  assert.ok(commands > 0);
  for (const [stage, after] of [["2a", publicFleet], ["2b", privateFleet]]) {
    const result = diffRenders({ before: stageOne.files, after, stage });
    assert.equal(result.ok, true, `${stage}: ${formatReport(result, { before: stageOne.files.size, after: after.size }).join("\n")}`);
    assert.deepEqual(result.leftovers, [], stage);
    assert.deepEqual(table(result).D8, [5 * commands, 5 * commands], `${stage}: three spellings of drift-lib, the package.json clause and the run, in each command`);
  }
});

test("stage 2a: the command of an instance that the engine rendered before the two clauses and the staged run, with the factory already in node_modules, gets them and nothing else changes", () => {
  const { public: publicFleet } = renders();
  const stageTwo = withWorkspaceRun(publicFleet);
  const bare = withoutClauses(stageTwo.files, "node_modules/ai-sdlc-factory");
  assert.ok(bare.counts.package > 0 && bare.counts.refusal === bare.counts.package && stageTwo.count === bare.counts.package, "the render has the two clauses and the staged run once in each validator command");
  const result = diffRenders({ before: bare.files, after: publicFleet, stage: "2a" });
  assert.equal(result.ok, true, formatReport(result, { before: bare.files.size, after: publicFleet.size }).join("\n"));
  assert.deepEqual(result.leftovers, []);
  assert.deepEqual(table(result).D8, [3 * bare.counts.package, 3 * bare.counts.package], "two clauses added to each command and its run turned into the staged copy, and no spelling to move");
  for (const row of result.rows) if (row.id !== "D8") assert.deepEqual([row.expected, row.applied], [0, 0], `${row.id}: nothing else of the render changed`);
});

test("a near miss of the two clauses is not explained, and neither is their removal: another clause, another order and an after side that lacks them are left over", () => {
  const { legacy } = renders();
  const bare = withoutClauses(legacy, ".");
  const dropped = diffRenders({ before: legacy, after: bare.files, stage: "1" });
  assert.equal(dropped.ok, false, "a render that lost the clauses is not explained");
  assert.match(dropped.leftovers.map((entry) => entry.diff).join("\n"), /package\.json is not the copy/);
  assert.equal(diffRenders({ before: bare.files, after: bare.files, stage: "1" }).ok, false, "the clauses are what D8 adds: an after side that never had them differs from the before side with them");
  const cases = [
    ["a package.json comparison that does not stop the command", packageClause("."), packageClause(".").replace("exit 1;", "exit 0;")],
    ["a package.json comparison of another file", packageClause("."), packageClause(".").replace('"$copy/./package.json"', '"$copy/./package-lock.json"')],
    ["a refusal of another directory", REFUSAL, REFUSAL.replace("scripts/node_modules\" ||", "lib/node_modules\" ||")],
    ["a refusal that tests for a directory only", REFUSAL, REFUSAL.replace("test -e", "test -d")],
    ["the package.json comparison after drift-lib, not before it", packageClause(".") + libClause("."), libClause(".") + packageClause(".")],
  ];
  for (const [label, from, to] of cases) {
    assert.ok([...legacy.values()].some((text) => text.includes(from)), `the case is real: ${label}`);
    const files = new Map([...legacy].map(([rel, text]) => [rel, text.split(from).join(to)]));
    const result = diffRenders({ before: files, after: legacy, stage: "1" });
    assert.equal(result.ok, false, label);
    assert.ok(result.leftovers.length > 0, `${label}: left over`);
  }
});

test("stage 1 keeps the workspace copy: the run is turned into the staged copy only where the stage moves the factory, and a render that went back to the workspace copy is not explained", () => {
  const { legacy, public: publicFleet } = renders();
  const stageOne = withWorkspaceRun(legacy);
  assert.ok(stageOne.count > 0);
  const kept = diffRenders({ before: stageOne.files, after: legacy, stage: "1" });
  assert.equal(kept.ok, false, "at stage 1 the stage-1 command (the workspace copy) is not turned into the staged one: the two are left over");
  const escaped = (text) => text.replaceAll('"', '\\"'); // the leftover is a diff of the JSON of the document, where a quote is escaped
  assert.ok(kept.leftovers.some((entry) => entry.diff.includes(escaped(STAGED_RUN)) && entry.diff.includes(escaped(WORKSPACE_RUN))), "the diff shows the workspace run and the staged run");
  assert.deepEqual(table(kept).D8, [0, 0], "and D8 counts no run at stage 1");
  assert.equal(diffRenders({ before: stageOne.files, after: stageOne.files, stage: "1" }).ok, true, "the stage-1 command against itself is empty");
  const back = diffRenders({ before: publicFleet, after: withWorkspaceRun(publicFleet).files, stage: "2a" });
  assert.equal(back.ok, false, "a render that runs the workspace copy again, where the before side ran the staged one, is a change that nothing explains");
  assert.ok(back.leftovers.some((entry) => entry.diff.includes(escaped(WORKSPACE_RUN))), "the diff shows the workspace run that came back");
});

test("a near miss of the staged run is not explained: a run that does not end the comparison, an unquoted run, and another script are left over", () => {
  const { legacy, public: publicFleet } = renders();
  const before = withWorkspaceRun(legacy).files;
  const cases = [
    ["a run that does not follow the comparison", REFUSAL + WORKSPACE_RUN, `${REFUSAL}echo done; ${WORKSPACE_RUN}`],
    ["an unquoted run", WORKSPACE_RUN, 'node $GITHUB_WORKSPACE/scripts/validate-example.mjs'],
    ["another script, which the comparison did not compare", WORKSPACE_RUN, 'node "$GITHUB_WORKSPACE/scripts/other.mjs"'],
    ["a longer name", WORKSPACE_RUN, 'node "$GITHUB_WORKSPACE/scripts/validate-example.mjs.bak"'],
    ["a run of the factory's copy", WORKSPACE_RUN, 'node "$GITHUB_WORKSPACE/node_modules/ai-sdlc-factory/scripts/validate-example.mjs"'],
  ];
  for (const [label, from, to] of cases) {
    assert.ok([...before.values()].some((text) => text.includes(from)), `the case is real: ${label}`);
    const files = new Map([...before].map(([rel, text]) => [rel, text.split(from).join(to)]));
    for (const stage of ["2a", "2b"]) {
      const result = diffRenders({ before: files, after: stage === "2a" ? publicFleet : renders().private, stage });
      assert.equal(result.ok, false, `${stage}: ${label}`);
      assert.ok(result.leftovers.length > 0, `${stage}: ${label}: left over`);
    }
  }
});

test("a near miss of the old validator comparison is not explained: an unquoted staged copy, a longer library name and a path with a trailing slash are left over", () => {
  const { legacy } = renders();
  const pre = preSplitShape(legacy);
  const stageOne = withWorkspaceRun(legacy).files;
  const cases = [
    ['"$copy/drift/lib"', "$copy/drift/lib"],
    ['"src/drift/lib is not the copy', '"src/drift/libs is not the copy'],
    ['"$GITHUB_WORKSPACE/src/drift/lib"', '"$GITHUB_WORKSPACE/src/drift/lib/"'],
    ['"$copy/validate-example.mjs"', '"$copy/validate-example.mjs.bak"'],
  ];
  for (const [from, to] of cases) {
    assert.ok([...pre.files.values()].some((text) => text.includes(from)), `the case is real: ${from}`);
    const files = new Map([...pre.files].map(([rel, text]) => [rel, text.split(from).join(to)]));
    const result = diffRenders({ before: files, after: stageOne, stage: "1", instanceScripts: ["validate-example.mjs"] });
    assert.equal(result.ok, false, from);
    assert.ok(result.leftovers.length > 0, `${from}: left over`);
  }
});

// ---- D10: the lock metadata ------------------------------------------------------------------------------------------------------------------------

test("lock metadata: the hashes of a lock are masked wherever they differ, and only they: another change in the lock is still reported", () => {
  // the committed locks are the relocated, private form, so the stage is 2a: D10 is allowed from stage 1 on, and the relocation is already in both
  const locks = committedLocks();
  assert.equal(locks.size, 13);
  const rehashed = new Map([...locks].map(([rel, text]) => [rel, text.replace(/("(?:frontmatter|body)_hash":")([0-9a-f])/g, (_, head, digit) => `${head}${digit === "0" ? "1" : "0"}`)]));
  assert.notDeepEqual([...rehashed.values()], [...locks.values()]);
  const same = diffRenders({ before: locks, after: rehashed, stage: "2a" });
  assert.equal(same.ok, true, formatReport(same, { before: 13, after: 13 }).join("\n"));
  assert.deepEqual(table(same).D10, [13, 13]);
  assert.equal(diffRenders({ before: locks, after: rehashed, stage: "0" }).ok, false, "stage 0 allows no masking");
  const changed = new Map(rehashed).set(`${W}/drift-docs-site.lock.yml`, rehashed.get(`${W}/drift-docs-site.lock.yml`).replace("npm ci --ignore-scripts", "npm ci"));
  const result = diffRenders({ before: locks, after: changed, stage: "2a" });
  assert.equal(result.ok, false);
  assert.deepEqual(result.leftovers.map((entry) => entry.file), [`${W}/drift-docs-site.lock.yml`]);
});

// ---- the command line ------------------------------------------------------------------------------------------------------------------------------

async function run(argv) {
  const lines = [];
  const code = await main(argv, { stdout: (line) => lines.push(line) });
  return { code, lines };
}

test("render writes the files of renderFleet, refuses a directory that is not empty, and reports a render that the factory refused", async (t) => {
  const instance = tmpDir(t);
  instanceOf(instance, "legacy");
  const out = path.join(tmpDir(t), "render");
  const first = await run(["render", "--instance", instance, "--request", engineAbs("examples", "request.reference.json"), "--out", out]);
  assert.equal(first.code, 0, first.lines.join("\n"));
  assert.deepEqual([...readRender(out).keys()], [...renders().legacy.keys()].sort());
  assert.equal([...readRender(out)].every(([rel, text]) => renders().legacy.get(rel) === text), true, "byte for byte what renderFleet returns");
  const again = await run(["render", "--instance", instance, "--request", engineAbs("examples", "request.reference.json"), "--out", out]);
  assert.equal(again.code, 2, "a render goes into a directory of its own");
  fs.writeFileSync(path.join(instance, "sdlc.yaml"), "not: a manifest\n");
  const refused = await run(["render", "--instance", instance, "--request", engineAbs("examples", "request.reference.json"), "--out", path.join(tmpDir(t), "other")]);
  assert.equal(refused.code, 1);
});

test("diff and selftest answer with exit codes: 0 when the renders agree, 1 when they do not, 2 for a usage error, and a real process says the same", async (t) => {
  const { legacy, public: publicFleet } = renders();
  const root = tmpDir(t);
  for (const [name, files] of [["legacy", legacy], ["public", publicFleet]]) writeTree(path.join(root, name), files);
  const base = ["diff", "--before", path.join(root, "legacy"), "--after"];
  const agree = await run([...base, path.join(root, "public"), "--stage", "2a"]);
  assert.equal(agree.code, 0);
  assert.ok(agree.lines.some((line) => /^D2 +49 +49 +ok/.test(line)) && agree.lines.at(-1).startsWith("RESULT: the renders agree"));
  const differ = await run([...base, path.join(root, "public"), "--stage", "1"]);
  assert.equal(differ.code, 1);
  assert.match(differ.lines.at(-1), /^RESULT: NOT EQUAL/);
  assert.equal((await run([...base, path.join(root, "public"), "--stage", "9"])).code, 2);
  assert.equal((await run(["diff", "--before", path.join(root, "legacy")])).code, 2, "--after and --stage are required");
  assert.equal((await run(["diff", "--before", path.join(root, "legacy"), "--after", path.join(root, "nowhere"), "--stage", "0"])).code, 2);
  assert.equal((await run(["bogus"])).code, 2);
  assert.equal((await run(["selftest", "--render", path.join(root, "legacy")])).code, 0);
  const real = spawnSync(process.execPath, [engineAbs("tools", "render-diff.mjs"), "diff", "--before", path.join(root, "legacy"), "--after", path.join(root, "public"), "--stage", "2a"], { encoding: "utf8", windowsHide: true });
  assert.equal(real.status, 0, real.stderr);
  assert.match(real.stdout, /RESULT: the renders agree modulo the allowed classes/);
  assert.equal(spawnSync(process.execPath, [engineAbs("tools", "render-diff.mjs")], { encoding: "utf8", windowsHide: true }).status, 2);
});

// ---- L2: the locks that the real compiler makes (G.5.2) ---------------------------------------------------------------------------------------------

test("L2: the old shape, the public factory and the private one all compile under gh aw --strict, the private locks are the committed ones, and the locks differ by the same classes", { skip: SKIP_REAL_GH_AW }, async (t) => {
  const pinned = read(".gh-aw-version").trim();
  assertGhAwAtLeast(pinned.replace(/^v/, ""));
  const root = tmpDir(t);
  const locks = {};
  for (const [kind, files] of Object.entries(renders())) {
    writeTree(path.join(root, `render-${kind}`), files);
    const compiled = await run(["compile", "--render", path.join(root, `render-${kind}`), "--out", path.join(root, `locks-${kind}`), "--expect-version", pinned]);
    assert.equal(compiled.code, 0, `${kind}: ${compiled.lines.join("\n")}`);
    locks[kind] = readRender(path.join(root, `locks-${kind}`));
    assert.equal(locks[kind].size, 13, `${kind}: thirteen locks`);
  }
  for (const [rel, text] of committedLocks()) assert.equal(locks.private.get(rel), text, `${rel}: a lock made by the command is the lock that the reconciler wrote`);
  const publicResult = diffRenders({ before: locks.legacy, after: locks.public, stage: "2a" });
  assert.equal(publicResult.ok, true, formatReport(publicResult, { before: 13, after: 13 }).join("\n"));
  assert.deepEqual([table(publicResult).D2, table(publicResult).D3, table(publicResult).D4a, table(publicResult).D10], [[48, 48], [18, 18], [9, 9], [13, 13]]);
  const privateResult = diffRenders({ before: locks.legacy, after: locks.private, stage: "2b" });
  assert.equal(privateResult.ok, true, formatReport(privateResult, { before: 13, after: 13 }).join("\n"));
  assert.deepEqual(table(privateResult).D4b, [27, 27], "token steps added == factory install steps, 27 in the locks");
  assert.equal(diffRenders({ before: locks.legacy, after: locks.private, stage: "2a" }).ok, false);
  assert.equal(selfTest(locks.legacy).ok, true, "the self test works on locks too");
  const refused = await run(["compile", "--render", path.join(root, "render-legacy"), "--out", path.join(root, "locks-again"), "--expect-version", "v0.0.1"]);
  assert.equal(refused.code, 2, "a compiler of another version is refused");
});
