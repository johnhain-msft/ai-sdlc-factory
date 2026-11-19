// The scripts of examples/ are the extension points of the factory, exercised (design H.5): a classifier for a report, a classifier for a snapshot, a helper with its own
// flags and exit codes, and a staged validator. They are run here as an orchestrator runs them: real node processes in a workspace that has the factory installed under
// node_modules (tests/helpers/adopter.mjs), reading the contract through the environment and the arguments that the router and the workflows give them.

import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import test from "node:test";
import { createAdopter } from "./helpers/adopter.mjs";
import { presetAbs, presetManifest } from "./helpers/preset.mjs";

const sha256 = (text) => crypto.createHash("sha256").update(text).digest("hex");
const COMMIT_A = "a".repeat(40);
const COMMIT_B = "b".repeat(40);

const CLEAN = "Inputs checked: 25; changed 0, new 0, gone 0\nThe content matches the inputs.\n";
const CHANGED = "Inputs checked: 25; changed 2, new 0, gone 1\n changed: content/page03.md\nThe content was written against different inputs.\n";
const PROBLEM = "Inputs checked: 25; changed 0, new 0, gone 0\n PROBLEM anchor: page07 cites a heading that is gone\n";

// ---- what they import ------------------------------------------------------------------------------------------------------------------------

test("every script of examples/ imports the factory only through its public surface, and the staged validator only through drift-lib", () => {
  const scripts = fs.readdirSync(presetAbs("scripts")).filter((name) => name.endsWith(".mjs")).sort();
  assert.deepEqual(scripts, ["check-sources.mjs", "classify-report.mjs", "classify-runs.mjs", "validate-example.mjs"]);
  for (const name of scripts) {
    const text = fs.readFileSync(presetAbs("scripts", name), "utf8");
    const specifiers = [...text.matchAll(/^import\b[^;]*?\bfrom\s+"([^"]+)"/gms)].map((match) => match[1]);
    for (const specifier of specifiers) assert.ok(specifier.startsWith("node:") || ["ai-sdlc-factory/script-kit", "ai-sdlc-factory/drift-lib"].includes(specifier), `${name} imports ${specifier}`);
    if (name === "validate-example.mjs") {
      for (const specifier of specifiers) assert.ok(specifier.startsWith("node:") || specifier === "ai-sdlc-factory/drift-lib", `the staged validator imports ${specifier}`);
    }
  }
  const manifest = presetManifest();
  const staged = manifest.projects.filter((project) => (project.driftAudit.stagedScripts ?? []).length > 0).flatMap((project) => project.driftAudit.stagedScripts);
  assert.deepEqual([...new Set(staged)], ["scripts/validate-example.mjs"], "the manifest stages the validator and nothing else");
});

// ---- the report classifier: the router tells it where the report is and what the check's exit code was ----------------------------------------------

function classifyReport(t, report, { exitCode = "1", file = true } = {}) {
  const adopter = createAdopter(t);
  adopter.write("report.txt", report);
  return adopter.node("scripts/classify-report.mjs", [], { env: { ...(file ? { SDLC_PREFLIGHT_STDOUT_FILE: adopter.abs("report.txt") } : {}), SDLC_PREFLIGHT_EXIT_CODE: exitCode } });
}

test("classify-report: 0 when nothing changed, whatever exit code the check had, and 1 for a changed, new or gone input or a PROBLEM line", (t) => {
  for (const exitCode of ["0", "1"]) {
    const clean = classifyReport(t, CLEAN, { exitCode });
    assert.equal(clean.code, 0, `${exitCode}: ${clean.stderr}`);
    assert.match(clean.stdout, /changed 0, new 0, gone 0, problems 0: no drift/);
  }
  for (const [label, report] of [["changed and gone", CHANGED], ["a problem line", PROBLEM], ["one new input", "Inputs checked: 3; changed 0, new 1, gone 0\n"], ["one gone input", "Inputs checked: 3; changed 0, new 0, gone 1\n"]]) {
    const drift = classifyReport(t, report);
    assert.equal(drift.code, 1, `${label}: ${drift.stderr}`);
    assert.match(drift.stdout, /: drift\n$/, label);
  }
});

test("classify-report: 2 when the check crashed, when the summary line is missing or doubled, and when the router did not set its variables", (t) => {
  for (const exitCode of ["2", "127", "130"]) {
    const crashed = classifyReport(t, CLEAN, { exitCode });
    assert.equal(crashed.code, 2, exitCode);
    assert.match(crashed.stderr, new RegExp(`the check exited with ${exitCode}`));
  }
  const none = classifyReport(t, "nothing that looks like a summary\n");
  assert.equal(none.code, 2);
  assert.match(none.stderr, /no summary line/);
  const doubled = classifyReport(t, `${CLEAN}${CHANGED}`);
  assert.equal(doubled.code, 2);
  assert.match(doubled.stderr, /2 summary lines/);
  assert.equal(classifyReport(t, CLEAN, { file: false }).code, 2, "without SDLC_PREFLIGHT_STDOUT_FILE");
});

// ---- the snapshot classifier ----------------------------------------------------------------------------------------------------------------

const run = (id, name, status = "completed") => ({ id, name, status, conclusion: status === "completed" ? "success" : null });

function classifyRuns(t, { listing, snapshot, exitCode = "0", raw }) {
  const adopter = createAdopter(t);
  adopter.write("listing.json", raw ?? JSON.stringify({ total_count: listing?.length ?? 0, workflow_runs: listing ?? [] }));
  if (snapshot !== undefined) adopter.write("hub/content/pipelines/runs.json", typeof snapshot === "string" ? snapshot : JSON.stringify({ runs: snapshot }));
  else adopter.write("hub/.keep", "");
  return adopter.node("scripts/classify-runs.mjs", [], { cwd: "hub", env: { SDLC_PREFLIGHT_STDOUT_FILE: adopter.abs("listing.json"), SDLC_PREFLIGHT_EXIT_CODE: exitCode } });
}

test("classify-runs: 0 while the newest completed run of every workflow is the one that the hub recorded, 1 when one is newer or not recorded", (t) => {
  const recorded = { build: 40, deploy: 31 };
  const same = classifyRuns(t, { listing: [run(40, "build"), run(39, "build"), run(31, "deploy")], snapshot: recorded });
  assert.equal(same.code, 0, same.stderr);
  assert.match(same.stdout, /the snapshot is unchanged/);
  const inProgress = classifyRuns(t, { listing: [run(41, "build", "in_progress"), run(40, "build"), run(31, "deploy")], snapshot: recorded });
  assert.equal(inProgress.code, 0, "a run that has not completed is not a change");
  const newer = classifyRuns(t, { listing: [run(42, "build"), run(31, "deploy")], snapshot: recorded });
  assert.equal(newer.code, 1);
  assert.match(newer.stdout, /newer runs: build \(42\)/);
  const added = classifyRuns(t, { listing: [run(40, "build"), run(31, "deploy"), run(50, "lint")], snapshot: recorded });
  assert.equal(added.code, 1, "a workflow that the hub does not show yet");
  assert.match(added.stdout, /lint \(50\)/);
});

test("classify-runs: 2 when the check failed, the listing is not a run list or the snapshot cannot be read", (t) => {
  assert.equal(classifyRuns(t, { listing: [], snapshot: {}, exitCode: "1" }).code, 2, "the check exited 1");
  const failed = classifyRuns(t, { listing: [], snapshot: {}, exitCode: "4" });
  assert.equal(failed.code, 2);
  assert.match(failed.stderr, /the check exited with 4/);
  assert.match(classifyRuns(t, { raw: "not json", snapshot: {} }).stderr, /not the JSON of a run list/);
  assert.match(classifyRuns(t, { raw: '{"message":"Not Found"}', snapshot: {} }).stderr, /no workflow_runs list/);
  assert.match(classifyRuns(t, { listing: [] }).stderr, /content\/pipelines\/runs\.json cannot be read/);
  assert.match(classifyRuns(t, { listing: [], snapshot: "[1, 2]" }).stderr, /no "runs" mapping/);
});

// ---- the helper with its own flags and exit codes --------------------------------------------------------------------------------------------------

const VIEWS = { "view-a": "labs/lab01.md", "view-b": "labs/lab02.md" };

/** An orchestrator workspace (its manifest, the script, the factory), a downstream checkout with the recorded sources and an upstream checkout. */
function sourceWorld(t, { upstream = { "labs/lab01.md": "one\n", "labs/lab02.md": "two\n" }, recorded = upstream, manifestInDownstream } = {}) {
  const adopter = createAdopter(t);
  for (const [file, text] of Object.entries(upstream)) adopter.write(`upstream/${file}`, text);
  const views = Object.fromEntries(Object.entries(VIEWS).map(([name, source]) => [name, { source, sha256: sha256(recorded[source] ?? "") }]));
  adopter.write("hub/apps/site/sources.json", `${JSON.stringify({ _provenance: { commit: COMMIT_A }, views }, null, 2)}\n`);
  if (manifestInDownstream) adopter.write("hub/sdlc.yaml", manifestInDownstream);
  // as the router gives them: absolute paths of the two checkouts
  const args = (extra = []) => ["--downstream", adopter.abs("hub"), "--upstream", adopter.abs("upstream"), "--commit", COMMIT_B, ...extra];
  const check = (extra = [], options = {}) => adopter.node("scripts/check-sources.mjs", args(extra), { cwd: "hub", env: { GITHUB_WORKSPACE: adopter.dir }, ...options });
  return { adopter, check, args, sources: () => JSON.parse(adopter.read("hub/apps/site/sources.json")) };
}

test("check-sources: 0 and an in-sync result while every source has the hash that its view recorded", (t) => {
  const { check } = sourceWorld(t);
  const result = check();
  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), { status: "in-sync", changed: [] });
});

test("check-sources: 1 and the views that changed or whose source is gone", (t) => {
  const changed = sourceWorld(t, { upstream: { "labs/lab01.md": "one, edited\n", "labs/lab02.md": "two\n" }, recorded: { "labs/lab01.md": "one\n", "labs/lab02.md": "two\n" } });
  const result = changed.check();
  assert.equal(result.code, 1, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), { status: "drift", changed: ["view-a"] });
  const gone = sourceWorld(t, { upstream: { "labs/lab01.md": "one\n" }, recorded: { "labs/lab01.md": "one\n", "labs/lab02.md": "two\n" } });
  assert.deepEqual(JSON.parse(gone.check().stdout), { status: "drift", changed: ["view-b"] });
});

test("check-sources --accept records the hashes and the commit, changes nothing else, and the next check is in sync", (t) => {
  const world = sourceWorld(t, { upstream: { "labs/lab01.md": "one, edited\n", "labs/lab02.md": "two\n" }, recorded: { "labs/lab01.md": "one\n", "labs/lab02.md": "two\n" } });
  assert.equal(world.check().code, 1);
  const accepted = world.check(["--accept"]);
  assert.equal(accepted.code, 0, accepted.stderr);
  assert.deepEqual(JSON.parse(accepted.stdout), { status: "accepted", commit: COMMIT_B });
  const recorded = world.sources();
  assert.equal(recorded._provenance.commit, COMMIT_B);
  assert.equal(recorded.views["view-a"].sha256, sha256("one, edited\n"));
  assert.equal(recorded.views["view-a"].source, "labs/lab01.md", "the rest of the view is kept");
  assert.equal(world.check().code, 0);
  assert.deepEqual(fs.readdirSync(world.adopter.abs("hub", "apps", "site")), ["sources.json"], "no temporary file is left");
});

test("check-sources: 2 and nothing written for a wrong flag, a missing section, a missing file, or a manifest that only the downstream has", (t) => {
  const { adopter, check, args, sources } = sourceWorld(t);
  const before = JSON.stringify(sources());
  for (const [label, extra, why] of [
    ["an unknown flag", ["--bogus"], /unknown option '--bogus'/],
    ["a missing flag", null, /--commit is required/],
  ]) {
    const result = extra === null ? adopter.node("scripts/check-sources.mjs", ["--downstream", adopter.abs("hub"), "--upstream", adopter.abs("upstream")], { cwd: "hub", env: { GITHUB_WORKSPACE: adopter.dir } }) : check(extra);
    assert.equal(result.code, 2, label);
    assert.match(result.stderr, why, label);
  }
  const badSha = adopter.node("scripts/check-sources.mjs", ["--downstream", adopter.abs("hub"), "--upstream", adopter.abs("upstream"), "--commit", "abc"], { cwd: "hub", env: { GITHUB_WORKSPACE: adopter.dir } });
  assert.equal(badSha.code, 2);
  assert.match(badSha.stderr, /40 lowercase hexadecimal/);
  fs.rmSync(adopter.abs("hub", "apps", "site", "sources.json"));
  const missing = check();
  assert.equal(missing.code, 2);
  assert.match(missing.stderr, /sources\.json/);
  adopter.write("hub/apps/site/sources.json", "{ not json");
  assert.equal(check().code, 2, "a file that is not JSON");
  adopter.write("hub/apps/site/sources.json", before);

  // the policy comes from the orchestrator's manifest, never from the downstream checkout that is being inspected
  const noSection = sourceWorld(t);
  fs.writeFileSync(noSection.adopter.abs("sdlc.yaml"), "projects: []\ndependencyEdges: []\n");
  const none = noSection.check();
  assert.equal(none.code, 2);
  assert.match(none.stderr, /no edge declares adaptation\.helpers\.sourceCheck/);
  const planted = sourceWorld(t, {
    upstream: { "labs/lab01.md": "one, edited\n", "labs/lab02.md": "two\n" },
    recorded: { "labs/lab01.md": "one\n", "labs/lab02.md": "two\n" },
    manifestInDownstream: fs.readFileSync(presetAbs("sdlc.yaml"), "utf8").replaceAll("apps/site/sources.json", "apps/site/planted.json"),
  });
  planted.adopter.write("hub/apps/site/planted.json", JSON.stringify({ views: {} }));
  const result = planted.check();
  assert.equal(result.code, 1, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), { status: "drift", changed: ["view-a"] }, "the downstream's own sdlc.yaml is skipped: its planted.json would have said in-sync");
});

// ---- the staged validator --------------------------------------------------------------------------------------------------------------------

const AUDIT = ["## Summary", "## Verification", "## Proposed additions", "## Run details"];
const IMPROVEMENT = ["## Summary", "## Findings", "## Run details"];
const report = (headings) => `# Report\n\n${headings.map((heading) => `${heading}\n\ntext\n`).join("\n")}`;

function validate(t, file, headings, args = []) {
  const adopter = createAdopter(t);
  adopter.write("target/.keep", "");
  if (headings !== null) adopter.write(`target/${file}`, report(headings));
  return adopter.node("scripts/validate-example.mjs", args, { cwd: "target", env: { GITHUB_WORKSPACE: adopter.dir } });
}

test("validate-example: 0 for a report with the sections in order, for the audit report and, with --self-improve, for the improvement report", (t) => {
  const audit = validate(t, "reports/audit-report.md", AUDIT);
  assert.equal(audit.code, 0, audit.stderr);
  assert.match(audit.stdout, /reports\/audit-report\.md is valid/);
  const improvement = validate(t, "reports/improvement-report.md", IMPROVEMENT, ["--self-improve"]);
  assert.equal(improvement.code, 0, improvement.stderr);
});

test("validate-example: 1 for a section that is missing, doubled or out of order, and for a report that is not there; 2 for a wrong flag", (t) => {
  const missing = validate(t, "reports/audit-report.md", AUDIT.filter((heading) => heading !== "## Verification"));
  assert.equal(missing.code, 1);
  assert.match(missing.stderr, /has no '## Verification' section/);
  const doubled = validate(t, "reports/audit-report.md", [...AUDIT, "## Run details"]);
  assert.equal(doubled.code, 1);
  assert.match(doubled.stderr, /'## Run details' section 2 times/);
  const reordered = validate(t, "reports/audit-report.md", ["## Verification", "## Summary", "## Proposed additions", "## Run details"]);
  assert.equal(reordered.code, 1);
  assert.match(reordered.stderr, /wrong order/);
  const absent = validate(t, "reports/audit-report.md", null);
  assert.equal(absent.code, 1);
  assert.match(absent.stderr, /reports\/audit-report\.md does not exist/);
  assert.equal(validate(t, "reports/audit-report.md", AUDIT, ["--self-improve"]).code, 1, "the audit report is not the improvement report");
  const bad = validate(t, "reports/audit-report.md", AUDIT, ["--nope"]);
  assert.equal(bad.code, 2);
  assert.match(bad.stderr, /unknown option '--nope'/);
});
