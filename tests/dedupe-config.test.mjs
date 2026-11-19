// Dedupe conventions as per-project manifest data (design section E3). The script that decides whether an open pull request is a duplicate used to hard-code
// one adopter's scheduled-workflow conventions (branch prefixes, labels, the upkeep that each stands for, and which upkeep a strategy does). They are now the
// `dedupe` block of the fleet, or of one project, and the engine keeps one convention of its own: the `sdlc/` branches of the renderer.
//
// Four parts: what the renderer emits (`--project`), what the schema and the rules refuse, how the script reads the block, and a table test that holds the new
// decisions equal to the old ones for the block that reproduces the old conventions (the instance half of this equivalence lives in the instance).

import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { decide, matchReasons, normalizeCloseOlderKey, run, upkeepOf, upkeepOfStrategy } from "../src/drift/dedupe-open-prs.mjs";
import { readProjectDedupe } from "../src/drift/lib/manifest.mjs";
import { renderFleet } from "../src/reconcile.mjs";
import { frontmatterOf, named } from "./helpers/rendered.mjs";
import { createWorkspace, referenceRequest } from "./helpers/mini-fleet.mjs";
import { invoke } from "./s2/helpers/run-script.mjs";
import { cleanEnv, createFakeFetch, json } from "./s2/helpers/stub-server.mjs";

/** The conventions that the engine used to hard-code, spelled with neutral names: two upkeeps, a label and two branch families each, and a strategy for each. */
const CONVENTIONS = {
  upkeeps: [
    { id: "weekly-audit", branchPrefixes: ["automation/weekly-audit-", "sdlc/weekly-audit-"], labels: ["content-audit"] },
    { id: "self-improve", branchPrefixes: ["automation/self-improve-", "sdlc/self-improve-"], labels: ["self-improving"] },
  ],
  strategyUpkeep: { "content-and-docs-sync": "weekly-audit", "code-quality-and-improvement-scan": "self-improve" },
};

const DEDUPE_STEP = "Deduplicate open pull requests";
const WORKFLOWS = ["drift-docs-site", "drift-lab-content", "implement-docs-site", "implement-lab-content"];
const PROJECTS = { "drift-docs-site": "docs-site", "drift-lab-content": "lab-content", "implement-docs-site": "docs-site", "implement-lab-content": "lab-content" };

function render(t, { mutate, manifestPath } = {}) {
  const work = createWorkspace(t, { mutate, manifestPath });
  const result = renderFleet(referenceRequest({ manifestPath: manifestPath ?? "sdlc.yaml" }), { cwd: work.dir });
  assert.equal(result.ok, true, JSON.stringify(result.result));
  return { work, files: result.files };
}

function failures(t, mutate) {
  const work = createWorkspace(t, { mutate });
  const result = renderFleet(referenceRequest(), { cwd: work.dir });
  assert.equal(result.ok, false, "the render was expected to be refused");
  return result.result.validationResults.flatMap((entry) => entry.errors);
}

const dedupeStep = (files, id) => named(frontmatterOf(files.get(`.github/workflows/${id}.md`))["pre-agent-steps"], DEDUPE_STEP);
const projectOf = (manifest, key) => manifest.projects.find((project) => project.projectKey === key);

// ---- the renderer ----------------------------------------------------------------------------------------------------------------------------

test("no dedupe block anywhere: the dedupe step of every drift and implement workflow is what it always was", (t) => {
  const { files } = render(t);
  for (const id of WORKFLOWS) {
    const step = dedupeStep(files, id);
    assert.doesNotMatch(step.run, /--project/, id);
    assert.deepEqual(Object.keys(step.env), ["CONFIGURED_TARGET_REPO", "APP_CLIENT_ID", "APP_PRIVATE_KEY"], id);
    assert.equal("SDLC_MANIFEST" in step.env, false, id);
  }
  assert.match(dedupeStep(files, "drift-docs-site").run, /^node "\$GITHUB_WORKSPACE\/src\/drift\/dedupe-open-prs\.mjs" --out \/tmp\/gh-aw\/agent --target-repo "\$CONFIGURED_TARGET_REPO" --close-older-key sdlc-drift-docs-site --upkeep-strategy content-and-docs-sync$/);
  assert.match(dedupeStep(files, "implement-lab-content").run, /^node "\$GITHUB_WORKSPACE\/src\/drift\/dedupe-open-prs\.mjs" --out \/tmp\/gh-aw\/agent --target-repo "\$CONFIGURED_TARGET_REPO" --upkeep-strategy code-quality-and-improvement-scan --implementation$/);
});

test("a fleet-level dedupe block adds --project to every drift and implement workflow, after the arguments that were there", (t) => {
  const none = render(t);
  const { files } = render(t, { mutate: (manifest) => (manifest.dedupe = structuredClone(CONVENTIONS)) });
  for (const id of WORKFLOWS) {
    const step = dedupeStep(files, id);
    assert.equal(step.run, `${dedupeStep(none.files, id).run} --project ${PROJECTS[id]}`, id);
    assert.deepEqual(step.env, dedupeStep(none.files, id).env, `${id}: nothing else changes in the step`);
  }
});

test("a project's own dedupe block is passed for that project alone, and an empty one replaces the fleet's", (t) => {
  const own = render(t, { mutate: (manifest) => (projectOf(manifest, "lab-content").driftAudit.dedupe = structuredClone(CONVENTIONS)) });
  assert.doesNotMatch(dedupeStep(own.files, "drift-docs-site").run, /--project/);
  assert.doesNotMatch(dedupeStep(own.files, "implement-docs-site").run, /--project/);
  assert.match(dedupeStep(own.files, "drift-lab-content").run, / --project lab-content$/);
  assert.match(dedupeStep(own.files, "implement-lab-content").run, / --implementation --project lab-content$/);

  const empty = render(t, {
    mutate: (manifest) => {
      manifest.dedupe = structuredClone(CONVENTIONS);
      projectOf(manifest, "docs-site").driftAudit.dedupe = {};
    },
  });
  assert.match(dedupeStep(empty.files, "drift-docs-site").run, / --project docs-site$/, "an empty block is still a block: the script reads it and finds no conventions");
});

test("a manifest kept at another path is named to the dedupe step, which reads it; the default location adds nothing", (t) => {
  const moved = render(t, { manifestPath: "config/fleet.yaml", mutate: (manifest) => (manifest.dedupe = structuredClone(CONVENTIONS)) });
  for (const id of WORKFLOWS) assert.equal(dedupeStep(moved.files, id).env.SDLC_MANIFEST, "config/fleet.yaml", id);
  const unconfigured = render(t, { manifestPath: "config/fleet.yaml" });
  for (const id of WORKFLOWS) assert.equal("SDLC_MANIFEST" in dedupeStep(unconfigured.files, id).env, false, `${id}: no block, nothing for the step to read`);
});

// ---- the schema and the rules ----------------------------------------------------------------------------------------------------------------

test("the schema accepts the block at the top and in a project, and refuses what the script could not use", (t) => {
  const ok = render(t, { mutate: (manifest) => ((manifest.dedupe = structuredClone(CONVENTIONS)), (projectOf(manifest, "docs-site").driftAudit.dedupe = { upkeeps: [] })) });
  assert.ok(ok.files.size > 0);
  const bad = [
    ["an upkeep id with a capital", { upkeeps: [{ id: "Weekly", branchPrefixes: [], labels: [] }] }],
    ["an upkeep without an id", { upkeeps: [{ branchPrefixes: ["a/"] }] }],
    ["a branch prefix that starts with a slash", { upkeeps: [{ id: "a", branchPrefixes: ["/a-"] }] }],
    ["a branch prefix with a space", { upkeeps: [{ id: "a", branchPrefixes: ["a b-"] }] }],
    ["an empty label", { upkeeps: [{ id: "a", labels: [""] }] }],
    ["a label longer than 50 characters", { upkeeps: [{ id: "a", labels: ["x".repeat(51)] }] }],
    ["a strategy that is not one of the four", { upkeeps: [{ id: "a" }], strategyUpkeep: { "something-else": "a" } }],
    ["an upkeep key that nobody declared", { upkeeps: [{ id: "a", surprise: true }] }],
    ["a key that is not part of the block", { upkeeps: [], surprise: true }],
  ];
  for (const [label, block] of bad) {
    for (const [where, mutate] of [
      ["the fleet", (manifest) => (manifest.dedupe = structuredClone(block))],
      ["a project", (manifest) => (projectOf(manifest, "lab-content").driftAudit.dedupe = structuredClone(block))],
    ]) {
      const errors = failures(t, mutate);
      assert.ok(errors.some((error) => error.startsWith("schema-validation: ") && error.includes("dedupe")), `${label} in ${where}: ${errors.join(" | ")}`);
    }
  }
});

test("dedupe-upkeep-duplicate: two upkeeps of one block do not share an id", (t) => {
  const errors = failures(t, (manifest) => (manifest.dedupe = { upkeeps: [{ id: "a" }, { id: "b" }, { id: "a", labels: ["x"] }] }));
  assert.ok(errors.some((error) => error.startsWith("dedupe-upkeep-duplicate: ") && error.includes("'a'") && error.includes("#/dedupe")), errors.join("\n"));
  const inProject = failures(t, (manifest) => (projectOf(manifest, "docs-site").driftAudit.dedupe = { upkeeps: [{ id: "a" }, { id: "a" }] }));
  assert.ok(inProject.some((error) => error.startsWith("dedupe-upkeep-duplicate: ") && error.includes("/projects/0/driftAudit/dedupe")), inProject.join("\n"));
});

test("dedupe-strategy-upkeep-unknown: a strategy names an upkeep that its own block declares", (t) => {
  const fleet = failures(t, (manifest) => (manifest.dedupe = { upkeeps: [{ id: "a" }], strategyUpkeep: { "content-and-docs-sync": "b" } }));
  assert.ok(fleet.some((error) => error.startsWith("dedupe-strategy-upkeep-unknown: ") && error.includes("'b'") && error.includes("content-and-docs-sync")), fleet.join("\n"));
  // the project's block replaces the fleet's, so it cannot lean on the fleet's upkeeps
  const project = failures(t, (manifest) => {
    manifest.dedupe = structuredClone(CONVENTIONS);
    projectOf(manifest, "lab-content").driftAudit.dedupe = { strategyUpkeep: { "code-quality-and-improvement-scan": "self-improve" } };
  });
  assert.ok(project.some((error) => error.startsWith("dedupe-strategy-upkeep-unknown: ") && error.includes("/projects/1/driftAudit/dedupe")), project.join("\n"));
});

test("the manifest-expression rule covers the block", (t) => {
  const errors = failures(t, (manifest) => (manifest.dedupe = { upkeeps: [{ id: "a", labels: ["${{ github.actor }}"] }] }));
  assert.ok(errors.some((error) => error.startsWith("manifest-expression-opener: ") && error.includes("/dedupe/upkeeps/0/labels/0")), errors.join("\n"));
});

// ---- reading the block -----------------------------------------------------------------------------------------------------------------------

function manifestFile(t, mutate, manifestPath = "sdlc.yaml") {
  const work = createWorkspace(t, { mutate, manifestPath });
  return work.path(...manifestPath.split("/"));
}

test("readProjectDedupe: the project's block wins, else the fleet's, else null, and a block is never merged with the other", async (t) => {
  const file = manifestFile(t, (manifest) => {
    manifest.dedupe = structuredClone(CONVENTIONS);
    projectOf(manifest, "lab-content").driftAudit.dedupe = { upkeeps: [{ id: "mine", branchPrefixes: ["bot/mine-"], labels: ["mine"] }], strategyUpkeep: { "code-quality-and-improvement-scan": "mine" } };
  });
  assert.deepEqual(await readProjectDedupe({ manifestPath: file, projectKey: "docs-site" }), CONVENTIONS, "no block of its own: the fleet's");
  assert.deepEqual(await readProjectDedupe({ manifestPath: file, projectKey: "lab-content" }), {
    upkeeps: [{ id: "mine", branchPrefixes: ["bot/mine-"], labels: ["mine"] }],
    strategyUpkeep: { "code-quality-and-improvement-scan": "mine" },
  }, "its own block, and none of the fleet's upkeeps");
  assert.deepEqual(await readProjectDedupe({ manifestPath: file, projectKey: "hub" }), CONVENTIONS, "a project that has none of its own takes the fleet's, whether or not it drifts");
});

test("readProjectDedupe: no block anywhere is null, an empty block is an empty configuration, and what is missing from a block is empty", async (t) => {
  const bare = manifestFile(t);
  assert.equal(await readProjectDedupe({ manifestPath: bare, projectKey: "docs-site" }), null);
  const empty = manifestFile(t, (manifest) => (projectOf(manifest, "docs-site").driftAudit.dedupe = {}));
  assert.deepEqual(await readProjectDedupe({ manifestPath: empty, projectKey: "docs-site" }), { upkeeps: [], strategyUpkeep: {} });
  const partial = manifestFile(t, (manifest) => (manifest.dedupe = { upkeeps: [{ id: "a" }] }));
  assert.deepEqual(await readProjectDedupe({ manifestPath: partial, projectKey: "docs-site" }), { upkeeps: [{ id: "a", branchPrefixes: [], labels: [] }], strategyUpkeep: {} });
});

test("readProjectDedupe stops on a damaged file, an unknown project, or a block that is not what the schema allows", async (t) => {
  const file = manifestFile(t);
  await assert.rejects(readProjectDedupe({ manifestPath: `${file}.missing`, projectKey: "docs-site" }), /cannot be read/);
  await assert.rejects(readProjectDedupe({ manifestPath: file, projectKey: "nobody" }), /has no project 'nobody'/);
  for (const [label, block, pattern] of [
    ["upkeeps that are not a list", { upkeeps: "a" }, /dedupe\.upkeeps of 'docs-site' is not a list/],
    ["an upkeep that is not an object", { upkeeps: ["a"] }, /dedupe\.upkeeps\[0\] of 'docs-site' is not an object/],
    ["an upkeep without an id", { upkeeps: [{ labels: ["x"] }] }, /dedupe\.upkeeps\[0\] of 'docs-site' has no id/],
    ["prefixes that are not a list", { upkeeps: [{ id: "a", branchPrefixes: "a-" }] }, /dedupe\.upkeeps\[0\]\.branchPrefixes of 'docs-site' is not a list/],
    ["prefixes that are not strings", { upkeeps: [{ id: "a", branchPrefixes: [1] }] }, /dedupe\.upkeeps\[0\]\.branchPrefixes\[0\] of 'docs-site' is not a string/],
    ["labels that are not a list", { upkeeps: [{ id: "a", labels: "x" }] }, /dedupe\.upkeeps\[0\]\.labels of 'docs-site' is not a list/],
    ["a strategy map that is not an object", { strategyUpkeep: ["a"] }, /dedupe\.strategyUpkeep of 'docs-site' is not an object/],
    ["a strategy that names an unknown upkeep", { upkeeps: [{ id: "a" }], strategyUpkeep: { "content-and-docs-sync": "b" } }, /dedupe\.strategyUpkeep\.content-and-docs-sync of 'docs-site' names the upkeep 'b'/],
  ]) {
    // the manifest is not validated by the reader's caller here, so the damage reaches the reader as it would in a workspace that was changed after reconcile
    const damaged = manifestFile(t, (manifest) => (projectOf(manifest, "docs-site").driftAudit.dedupe = block));
    await assert.rejects(readProjectDedupe({ manifestPath: damaged, projectKey: "docs-site" }), pattern, label);
  }
});

// ---- the decisions ---------------------------------------------------------------------------------------------------------------------------

const pull = (number, ref, labels = [], body = "") => ({ number, html_url: `https://github.example/example-org/example-target/pull/${number}`, head: { ref }, labels: labels.map((name) => ({ name })), draft: false, body });

test("without a block only the engine's own sdlc/ branches are candidates, and every other match is a possible duplicate", () => {
  assert.deepEqual(matchReasons(pull(1, "sdlc/x")), ["head branch matches sdlc/*"]);
  assert.deepEqual(matchReasons(pull(1, "sdlc/x"), null), ["head branch matches sdlc/*"]);
  assert.deepEqual(matchReasons(pull(1, "automation/weekly-audit-1", ["content-audit"])), [], "what only the owner's conventions would match is no candidate");
  assert.deepEqual(matchReasons(pull(1, "docs/sdlc/x")), []);
  assert.deepEqual(matchReasons(pull(1, "SDLC/x")), []);
  assert.deepEqual(matchReasons({}), []);
  assert.equal(upkeepOf(pull(1, "sdlc/weekly-audit-1", ["content-audit"])), null, "no upkeep is declared, so none is told");
  assert.equal(upkeepOfStrategy(null, "content-and-docs-sync"), null);
  assert.deepEqual(decide(pull(1, "sdlc/x"), { closeOlderKey: null, upkeep: null }), { belongsTo: "another-workflow-or-schedule", upkeep: null, decision: "skip" });
});

test("a declared prefix or label makes a candidate with the reason that the engine always gave, and sdlc/ stays the engine's own", () => {
  assert.deepEqual(matchReasons(pull(1, "automation/weekly-audit-2026-11-01"), CONVENTIONS), ["head branch matches automation/weekly-audit-*"]);
  assert.deepEqual(matchReasons(pull(1, "sdlc/weekly-audit-2026-11-01"), CONVENTIONS), ["head branch matches sdlc/*"], "a declared sdlc/ prefix adds no second reason for the same branch");
  assert.deepEqual(matchReasons(pull(1, "x", ["content-audit", "automated"]), CONVENTIONS), ["carries the label content-audit"]);
  assert.deepEqual(matchReasons(pull(1, "sdlc/x", ["content-audit", "self-improving"]), CONVENTIONS), ["head branch matches sdlc/*", "carries the label content-audit", "carries the label self-improving"]);
  assert.deepEqual(matchReasons(pull(1, "automation/weekly-audit"), CONVENTIONS), [], "the prefix is the whole string up to its dash");
  assert.deepEqual(matchReasons(pull(1, "x", ["Content-Audit"]), CONVENTIONS), [], "labels are matched exactly");
  assert.deepEqual(matchReasons(pull(1, "docs/automation/weekly-audit-x"), CONVENTIONS), [], "a prefix has to be at the start");
  const custom = { upkeeps: [{ id: "nightly", branchPrefixes: ["bot/nightly-", "ci/nightly-"], labels: ["nightly", "bot"] }], strategyUpkeep: {} };
  assert.deepEqual(matchReasons(pull(1, "bot/nightly-3", ["bot", "nightly"]), custom), ["head branch matches bot/nightly-*", "carries the label nightly", "carries the label bot"]);
  assert.deepEqual(matchReasons(pull(1, "ci/nightly-3"), custom), ["head branch matches ci/nightly-*"]);
});

test("an upkeep is told by a head branch that starts with one of its prefixes or by one of its labels; a pull request of two upkeeps, or of none, has none", () => {
  assert.equal(upkeepOf(pull(1, "automation/weekly-audit-1"), CONVENTIONS), "weekly-audit");
  assert.equal(upkeepOf(pull(1, "sdlc/weekly-audit-1"), CONVENTIONS), "weekly-audit");
  assert.equal(upkeepOf(pull(1, "automation/self-improve-1"), CONVENTIONS), "self-improve");
  assert.equal(upkeepOf(pull(1, "feature/x", ["content-audit"]), CONVENTIONS), "weekly-audit");
  assert.equal(upkeepOf(pull(1, "feature/x", ["self-improving"]), CONVENTIONS), "self-improve");
  assert.equal(upkeepOf(pull(1, "sdlc/weekly-audit-x", ["content-audit"]), CONVENTIONS), "weekly-audit", "the head and the label agree");
  assert.equal(upkeepOf(pull(1, "sdlc/weekly-audit-x", ["self-improving"]), CONVENTIONS), null, "the head and the label disagree");
  assert.equal(upkeepOf(pull(1, "sdlc/x"), CONVENTIONS), null);
  assert.equal(upkeepOf(pull(1, "docs/sdlc/weekly-audit-x"), CONVENTIONS), null);
  assert.equal(upkeepOf({}, CONVENTIONS), null);
  assert.equal(upkeepOfStrategy(CONVENTIONS, "content-and-docs-sync"), "weekly-audit");
  assert.equal(upkeepOfStrategy(CONVENTIONS, "code-quality-and-improvement-scan"), "self-improve");
  assert.equal(upkeepOfStrategy(CONVENTIONS, "dependency-and-pattern-modernization"), null);
  assert.equal(upkeepOfStrategy(CONVENTIONS, "custom"), null);
  assert.equal(upkeepOfStrategy(CONVENTIONS, "toString"), null, "a name that is on every object is not a strategy");
  assert.equal(upkeepOfStrategy(CONVENTIONS, ""), null);
});

test("decide: another upkeep's pull request is no duplicate, the same or an unknown one is, and the engine's other rules are what they were", () => {
  const workflow = (overrides = {}) => ({ closeOlderKey: "sdlc-drift-docs-site", upkeep: "weekly-audit", implementation: false, config: CONVENTIONS, ...overrides });
  assert.deepEqual(decide(pull(1, "automation/self-improve-1"), workflow()), { belongsTo: "another-workflow-or-schedule", upkeep: "self-improve", decision: "ignore" });
  assert.deepEqual(decide(pull(2, "automation/weekly-audit-1"), workflow()), { belongsTo: "another-workflow-or-schedule", upkeep: "weekly-audit", decision: "skip" });
  assert.deepEqual(decide(pull(3, "sdlc/other-workflow-1"), workflow()), { belongsTo: "another-workflow-or-schedule", upkeep: null, decision: "skip" }, "not known to be another upkeep counts as the same");
  assert.deepEqual(decide(pull(4, "sdlc/x", [], "<!-- gh-aw-close-key: sdlc-drift-docs-site -->"), workflow()), { belongsTo: "current-workflow", upkeep: null, decision: "ignore" });
  assert.deepEqual(decide(pull(5, "sdlc/implement-report-12"), workflow()), { belongsTo: "implementation", upkeep: null, decision: "ignore" });
  assert.deepEqual(decide(pull(6, "sdlc/x"), workflow({ closeOlderKey: null, implementation: true })), { belongsTo: "another-workflow-or-schedule", upkeep: null, decision: "ignore" });
  assert.deepEqual(decide(pull(7, "automation/weekly-audit-1"), workflow({ closeOlderKey: null, implementation: true })), { belongsTo: "another-workflow-or-schedule", upkeep: "weekly-audit", decision: "skip" }, "with --implementation only the target's own schedules decide");
  assert.deepEqual(decide(pull(8, "automation/self-improve-1"), workflow({ upkeep: null })), { belongsTo: "another-workflow-or-schedule", upkeep: "self-improve", decision: "skip" }, "a workflow without an upkeep cannot tell it apart");
  assert.deepEqual(decide(pull(9, "automation/self-improve-1"), workflow({ config: null })), { belongsTo: "another-workflow-or-schedule", upkeep: null, decision: "skip" }, "without a block nothing is known about the pull request either");
  assert.equal(normalizeCloseOlderKey("SDLC Drift/Docs"), "sdlc-drift-docs");
});

// ---- the table: the new decisions equal the old ones for the block that reproduces the old conventions --------------------------------------------

/** The functions of the script as they were before the conventions became data, with the same names for the same conventions, kept verbatim as the reference. */
const legacy = (() => {
  const BRANCH_PREFIXES = ["automation/weekly-audit-", "automation/self-improve-", "sdlc/"];
  const BRANCH_PATTERNS = BRANCH_PREFIXES.map((prefix) => `${prefix}*`);
  const LABELS = ["content-audit", "self-improving"];
  const UPKEEP_OF_LABEL = { "content-audit": "weekly-audit", "self-improving": "self-improve" };
  const UPKEEP_OF_STEM = [["weekly-audit-", "weekly-audit"], ["self-improve-", "self-improve"]];
  const UPKEEP_OF_STRATEGY = { "content-and-docs-sync": "weekly-audit", "code-quality-and-improvement-scan": "self-improve" };
  const IMPLEMENTATION_HEAD = /^sdlc\/implement-report-[1-9][0-9]*$/;
  const matchReasonsOld = (pull) => {
    const reasons = [];
    const ref = String(pull?.head?.ref ?? "");
    BRANCH_PREFIXES.forEach((prefix, position) => {
      if (ref.startsWith(prefix)) reasons.push(`head branch matches ${BRANCH_PATTERNS[position]}`);
    });
    const labels = (Array.isArray(pull?.labels) ? pull.labels : []).map((label) => String(label?.name ?? ""));
    for (const label of LABELS) if (labels.includes(label)) reasons.push(`carries the label ${label}`);
    return reasons;
  };
  const belongsOld = (pull, closeOlderKey) => {
    const key = normalizeCloseOlderKey(closeOlderKey);
    return key !== "" && String(pull?.body ?? "").includes(`<!-- gh-aw-close-key: ${key} -->`);
  };
  const upkeepOfOld = (pull) => {
    const stem = String(pull?.head?.ref ?? "").replace(/^(?:automation|sdlc)\//, "");
    const found = new Set(UPKEEP_OF_STEM.filter(([prefix]) => stem.startsWith(prefix)).map(([, upkeep]) => upkeep));
    for (const label of Array.isArray(pull?.labels) ? pull.labels : []) {
      const upkeep = Object.hasOwn(UPKEEP_OF_LABEL, String(label?.name ?? "")) ? UPKEEP_OF_LABEL[String(label.name)] : undefined;
      if (upkeep !== undefined) found.add(upkeep);
    }
    return found.size === 1 ? [...found][0] : null;
  };
  const decideOld = (pull, workflow) => {
    const upkeep = upkeepOfOld(pull);
    if (workflow.closeOlderKey !== null && belongsOld(pull, workflow.closeOlderKey)) return { belongsTo: "current-workflow", upkeep, decision: "ignore" };
    const head = String(pull?.head?.ref ?? "");
    const known = workflow.closeOlderKey !== null || workflow.implementation === true;
    if (known && IMPLEMENTATION_HEAD.test(head)) return { belongsTo: "implementation", upkeep, decision: "ignore" };
    if (workflow.implementation === true && head.startsWith("sdlc/")) return { belongsTo: "another-workflow-or-schedule", upkeep, decision: "ignore" };
    const other = workflow.upkeep !== null && upkeep !== null && upkeep !== workflow.upkeep;
    return { belongsTo: "another-workflow-or-schedule", upkeep, decision: other ? "ignore" : "skip" };
  };
  const upkeepOfStrategyOld = (strategy) => (Object.hasOwn(UPKEEP_OF_STRATEGY, strategy) ? UPKEEP_OF_STRATEGY[strategy] : null);
  return { matchReasons: matchReasonsOld, upkeepOf: upkeepOfOld, decide: decideOld, upkeepOfStrategy: upkeepOfStrategyOld };
})();

const REFS = [
  "automation/weekly-audit-2026-11-01", "automation/self-improve-2026-11-02", "automation/weekly-audit-", "automation/weekly-audit", "automation/other-1",
  "sdlc/weekly-audit-2026-11-01", "sdlc/self-improve-2026-11-02", "sdlc/x", "sdlc/a/b", "sdlc/implement-report-7", "sdlc/implement-report-0", "sdlc/implement-report-7x", "sdlc",
  "SDLC/x", "feature/x", "docs/automation/weekly-audit-x", "docs/sdlc/weekly-audit-x", "release/1.0", "", "main",
];
const LABEL_SETS = [[], ["content-audit"], ["self-improving"], ["content-audit", "self-improving"], ["other"], ["Content-Audit"], ["content-audit", "other"]];
const BODIES = ["", "<!-- gh-aw-close-key: sdlc-drift-docs-site -->", "<!-- gh-aw-close-key: some-other-key -->"];
const STRATEGIES = ["content-and-docs-sync", "code-quality-and-improvement-scan", "dependency-and-pattern-modernization", "custom", ""];
const WORKFLOW_KINDS = [{ closeOlderKey: "sdlc-drift-docs-site", implementation: false }, { closeOlderKey: null, implementation: true }, { closeOlderKey: null, implementation: false }];

test("table: for the block that reproduces the old conventions every decision of the script equals the old one", () => {
  let compared = 0;
  for (const ref of REFS) {
    for (const labels of LABEL_SETS) {
      for (const body of BODIES) {
        const candidate = pull(1, ref, labels, body);
        assert.deepEqual(matchReasons(candidate, CONVENTIONS), legacy.matchReasons(candidate), `reasons of ${JSON.stringify([ref, labels])}`);
        assert.equal(upkeepOf(candidate, CONVENTIONS), legacy.upkeepOf(candidate), `upkeep of ${JSON.stringify([ref, labels])}`);
        for (const kind of WORKFLOW_KINDS) {
          for (const strategy of STRATEGIES) {
            const upkeep = upkeepOfStrategy(CONVENTIONS, strategy);
            assert.equal(upkeep, legacy.upkeepOfStrategy(strategy), `the upkeep of ${strategy}`);
            const workflow = { ...kind, upkeep };
            assert.deepEqual(decide(candidate, { ...workflow, config: CONVENTIONS }), legacy.decide(candidate, workflow), `decision for ${JSON.stringify([ref, labels, body, kind, strategy])}`);
            compared += 1;
          }
        }
      }
    }
  }
  assert.ok(compared > 5000, `${compared} decisions compared`);
});

test("table: the one reading that is not carried over is a head branch without its namespace (weekly-audit-x), which is a candidate only through a label of another upkeep", () => {
  // The old code stripped `automation/` or `sdlc/` and then read the stem, so a bare `weekly-audit-x` was an upkeep of its own. A bare branch is no candidate by its
  // head (no prefix matches), so the reading can only differ for a pull request that is a candidate through a label, and then only when that label is another upkeep's.
  const bare = pull(1, "weekly-audit-x", ["self-improving"]);
  assert.equal(legacy.upkeepOf(bare), null, "old: the head says weekly-audit and the label says self-improve, so neither");
  assert.equal(upkeepOf(bare, CONVENTIONS), "self-improve", "new: the head is no declared prefix, so the label alone says");
  const alone = pull(2, "weekly-audit-x");
  assert.deepEqual(legacy.matchReasons(alone), []);
  assert.deepEqual(matchReasons(alone, CONVENTIONS), []);
  assert.equal(legacy.upkeepOf(alone), "weekly-audit");
  assert.equal(upkeepOf(alone, CONVENTIONS), null);
});

// ---- the script ------------------------------------------------------------------------------------------------------------------------------

const OWNER = "example-org";
const REPO = "example-target";
const TOKEN = "ghs_installationtokenfixture";
const OPEN = [
  pull(11, "automation/weekly-audit-2026-11-01"),
  pull(12, "automation/self-improve-2026-11-02"),
  pull(13, "sdlc/weekly-audit-2026-11-01"),
  pull(14, "feature/audited", ["content-audit", "automated"]),
  pull(15, "feature/agents", ["self-improving"]),
  pull(16, "feature/x"),
];
const fetchOf = (list = OPEN) => createFakeFetch((entry) => (entry.path === `/repos/${OWNER}/${REPO}/pulls` ? json(200, list) : json(404, { message: "Not Found" })));

async function runDedupe(t, { args = [], mutate, manifestPath = "sdlc.yaml", env = {}, list } = {}) {
  const work = createWorkspace(t, { mutate, manifestPath });
  const out = work.path("agent");
  const result = await invoke(run, ["--out", out, "--target-repo", `${OWNER}/${REPO}`, ...args], {
    env: cleanEnv({ GITHUB_WORKSPACE: work.dir, SDLC_MANIFEST: "", GH_APP_INSTALLATION_TOKEN: TOKEN, ...env }),
    cwd: work.dir,
    fetch: fetchOf(list),
  });
  let report = null;
  try {
    report = JSON.parse(fs.readFileSync(work.path("agent", "open-pr-dedup.json"), "utf8"));
  } catch {
    // a failed run writes nothing
  }
  return { ...result, report, work };
}

test("--project reads the project's conventions from sdlc.yaml in the workspace: the pull requests of its upkeeps are candidates and the decision tells whose they are", async (t) => {
  const result = await runDedupe(t, {
    args: ["--project", "docs-site", "--close-older-key", "sdlc-drift-docs-site", "--upkeep-strategy", "content-and-docs-sync"],
    mutate: (manifest) => (manifest.dedupe = structuredClone(CONVENTIONS)),
  });
  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(result.report.matches.map((match) => [match.number, match.reasons, match.upkeep, match.decision]), [
    [11, ["head branch matches automation/weekly-audit-*"], "weekly-audit", "skip"],
    [12, ["head branch matches automation/self-improve-*"], "self-improve", "ignore"],
    [13, ["head branch matches sdlc/*"], "weekly-audit", "skip"],
    [14, ["carries the label content-audit"], "weekly-audit", "skip"],
    [15, ["carries the label self-improving"], "self-improve", "ignore"],
  ]);
  assert.equal(result.report.upkeep, "weekly-audit");
  assert.equal(result.report.duplicate, true);
});

test("without --project only the engine's own branches are candidates, whatever the manifest declares", async (t) => {
  const result = await runDedupe(t, { args: ["--upkeep-strategy", "content-and-docs-sync"], mutate: (manifest) => (manifest.dedupe = structuredClone(CONVENTIONS)) });
  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(result.report.matches.map((match) => [match.number, match.decision]), [[13, "skip"]]);
  assert.equal(result.report.upkeep, null, "and no upkeep is told");
});

test("--project reads the manifest that SDLC_MANIFEST names", async (t) => {
  const result = await runDedupe(t, { args: ["--project", "lab-content"], manifestPath: "config/fleet.yaml", env: { SDLC_MANIFEST: "config/fleet.yaml" }, mutate: (manifest) => (manifest.dedupe = structuredClone(CONVENTIONS)) });
  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.report.matches.length, 5);
  const missing = await runDedupe(t, { args: ["--project", "lab-content"], mutate: (manifest) => (manifest.dedupe = structuredClone(CONVENTIONS)), env: { SDLC_MANIFEST: "config/elsewhere.yaml" } });
  assert.equal(missing.code, 1);
  assert.match(missing.stderr, /config[\\/]elsewhere\.yaml/, "the message names the file that was looked for");
  assert.equal(missing.report, null, "and nothing is written: an unknown state is never 'no duplicate'");
});

test("--project of a project that the manifest does not have, or of a manifest that is damaged, fails the step and writes nothing", async (t) => {
  const unknown = await runDedupe(t, { args: ["--project", "nobody"] });
  assert.equal(unknown.code, 1);
  assert.match(unknown.stderr, /has no project 'nobody'/);
  assert.equal(unknown.report, null);
  const damaged = await runDedupe(t, { args: ["--project", "docs-site"], mutate: (manifest) => (projectOf(manifest, "docs-site").driftAudit.dedupe = { upkeeps: "a" }) });
  assert.equal(damaged.code, 1);
  assert.match(damaged.stderr, /dedupe\.upkeeps of 'docs-site' is not a list/);
  assert.equal(damaged.report, null);
  const flag = await runDedupe(t, { args: ["--project"] });
  assert.equal(flag.code, 2, "a flag without a value is a usage error");
});

test("a project with no block of its own and a fleet without one has no conventions of its own, and the step still runs", async (t) => {
  const result = await runDedupe(t, { args: ["--project", "hub"] });
  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(result.report.matches.map((match) => match.number), [13]);
});
