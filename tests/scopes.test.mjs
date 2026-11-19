// Sync scopes are free-form per-edge ids (design section E1): the manifest declares them in `syncScopes`, the router dispatches one of them, and the first
// step of the AI workflow refuses any other. `both` is the one reserved id: everything the edge syncs, and the default.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { frontmatterOf } from "./helpers/rendered.mjs";
import { renderFleet } from "../src/reconcile.mjs";
import { chooseSyncScope } from "../src/routing/preflight.mjs";
import { validateShape } from "../src/routing/schema.mjs";
import { findBash } from "./s3/helpers/git-world.mjs";
import { createWorkspace, referenceRequest } from "./helpers/mini-fleet.mjs";
import { PRESET_ROOT, presetManifest } from "./helpers/preset.mjs";

const ENGINE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const AI = ".github/workflows/cascade-ai-lab-to-hub.md";

function render(t, syncScopes) {
  const work = createWorkspace(t, {
    mutate: (manifest) => {
      if (syncScopes === undefined) delete manifest.dependencyEdges[1].syncScopes;
      else manifest.dependencyEdges[1].syncScopes = syncScopes;
    },
  });
  return renderFleet(referenceRequest(), { cwd: work.dir });
}

const errorsOf = (result) => result.result.validationResults.flatMap((entry) => entry.errors);
const validationStep = (files) => frontmatterOf(files.get(AI))["pre-agent-steps"].find((step) => step.name === "Validate dispatch inputs and checkouts");
const caseLine = (files) => validationStep(files).run.split("\n").find((line) => line.startsWith('case "$SYNC_SCOPE" in'));

test("an edge declares its own scope ids, and the workflow's first step accepts exactly those", (t) => {
  const result = render(t, ["both", "content-only", "runs-only"]);
  assert.equal(result.ok, true, JSON.stringify(result.result));
  assert.equal(caseLine(result.files), 'case "$SYNC_SCOPE" in both|content-only|runs-only) ;; *) fail "sync_scope is not accepted by this workflow: $SYNC_SCOPE" ;; esac');
});

test("without syncScopes an edge accepts only both", (t) => {
  const result = render(t, undefined);
  assert.equal(result.ok, true, JSON.stringify(result.result));
  assert.equal(caseLine(result.files), 'case "$SYNC_SCOPE" in both) ;; *) fail "sync_scope is not accepted by this workflow: $SYNC_SCOPE" ;; esac');
});

test("a scope id is a short lower-case word that no shell metacharacter can be part of, and the list holds at least one, without repeats", (t) => {
  for (const id of ["a", "a1", "content-only", "0-9", "x".repeat(63)]) {
    assert.equal(render(t, [id]).ok, true, id);
  }
  for (const id of ["", "Content", "a_b", "a b", "-a", "a;touch-x", "$(id)", "a|b", "a)b", "*", 'a"b', "a'b", "a\nb", "x".repeat(64), "é"]) {
    const result = render(t, [id]);
    assert.equal(result.ok, false, JSON.stringify(id));
    assert.match(errorsOf(result).join("\n"), /^schema-validation: .*syncScopes\/0/m, JSON.stringify(id));
  }
  assert.equal(render(t, []).ok, false, "an empty list leaves the workflow with nothing it could accept");
  assert.equal(render(t, ["both", "both"]).ok, false, "a repeated id");
});

test("the case pattern of the rendered step accepts the declared scopes and refuses everything else when bash runs it", (t) => {
  const bash = findBash();
  if (!bash) return t.skip("no bash on this host");
  const files = render(t, ["both", "content-only"]).files;
  const line = caseLine(files);
  const attempt = (scope) =>
    spawnSync(bash, ["--noprofile", "--norc", "-c", `fail() { echo "$1" >&2; exit 2; }\nSYNC_SCOPE="$1"\n${line}`, "bash", scope], { encoding: "utf8", windowsHide: true });
  for (const scope of ["both", "content-only"]) assert.equal(attempt(scope).status, 0, scope);
  for (const scope of ["runs-only", "", "content-only ", "both|content-only", "*", "content-only;echo-pwned"]) {
    const outcome = attempt(scope);
    assert.equal(outcome.status, 2, JSON.stringify(scope));
    assert.match(outcome.stderr, /sync_scope is not accepted by this workflow/);
  }
});

test("the dispatch inputs and the manifest edge of the routing schema take the same pattern", () => {
  const inputs = (scope) => ({
    correlation_id: "run-1-1",
    upstream_repo: "example-org/lab-content",
    previous_sha: "a".repeat(40),
    upstream_sha: "b".repeat(40),
    upstream_etag: "",
    upstream_pr_number: "",
    downstream_repo: "example-org/hub",
    sync_scope: scope,
    on_commit_only_advance: "noop",
    dry_run: "",
  });
  for (const scope of ["both", "content-only", "a"]) assert.equal(validateShape("AiCascadeDispatchInputs", inputs(scope)).valid, true, scope);
  for (const scope of ["", "Content", "a b", "-a", "a;b", "x".repeat(64)]) assert.equal(validateShape("AiCascadeDispatchInputs", inputs(scope)).valid, false, JSON.stringify(scope));

  const edge = (syncScopes) => ({
    edgeId: "lab-to-hub",
    upstreamRepo: "example-org/lab-content",
    upstreamKey: "lab-content",
    upstreamSlug: "LAB_CONTENT",
    upstreamDefaultBranch: "main",
    downstreamRepo: "example-org/hub",
    mode: "ai-adaptation",
    stateVariable: "SDLC_SYNC_STATE_LAB_CONTENT",
    provenanceJsonPointer: "/commit",
    syncScopes,
  });
  assert.equal(validateShape("ManifestEdge", edge(["both", "content-only"])).valid, true);
  assert.equal(validateShape("ManifestEdge", edge(["Bad Scope"])).valid, false);
});

test("chooseSyncScope keeps a scope that the edge accepts and otherwise names one that it does", () => {
  assert.equal(chooseSyncScope("content-only", undefined), "content-only");
  assert.equal(chooseSyncScope("content-only", []), "content-only");
  assert.equal(chooseSyncScope("content-only", ["both", "content-only"]), "content-only");
  assert.equal(chooseSyncScope("content-only", ["both"]), "both");
  assert.equal(chooseSyncScope("content-only", ["runs-only"]), "runs-only", "no both: the first one that is accepted");
  assert.equal(chooseSyncScope(null, undefined), "both");
  assert.equal(chooseSyncScope(null, ["runs-only", "both"]), "both");
  assert.equal(chooseSyncScope(null, ["runs-only", "content-only"]), "runs-only");
});

test("the preset's rendered workflows accept exactly its declared scopes, without a renderer-wide scope list", () => {
  assert.doesNotMatch(fs.readFileSync(path.join(ENGINE_ROOT, "src", "reconcile.mjs"), "utf8"), /ALL_SYNC_SCOPES/);
  const result = renderFleet(referenceRequest(), { cwd: PRESET_ROOT });
  assert.equal(result.ok, true, JSON.stringify(result.result));
  const edges = presetManifest().dependencyEdges.filter((edge) => edge.mode === "ai-adaptation");
  const workflows = [...result.files.keys()].filter((file) => /^\.github\/workflows\/cascade-ai-.+\.md$/.test(file));
  assert.equal(workflows.length, edges.length);
  for (const edge of edges) {
    const file = `.github/workflows/cascade-ai-${edge.edgeId}.md`;
    const text = result.files.get(file);
    assert.equal(typeof text, "string", file);
    const scopeCases = [...text.matchAll(/^\s*case "\$SYNC_SCOPE" in ([a-z0-9|-]+)\)/gm)];
    assert.equal(scopeCases.length, 1, `${file}: exactly one scope guard`);
    assert.deepEqual(scopeCases[0][1].split("|"), edge.syncScopes ?? ["both"], `${file}: no undeclared scope is accepted`);
  }
});
