// Route the reference fleet's committed matrix, not synthetic substitutes for its edges.
// Processes and GitHub are stubbed; classifier calls inspect the router's real report files.
import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { presetAbs, presetEdges, presetManifest } from "./helpers/preset.mjs";
import { fakePreflight } from "./s3/helpers/fake-preflight.mjs";
import { fixture, NOW_ISO, readJson, routerMatrixEntries, sha, state } from "./s3/helpers/fixtures.mjs";
import { routerWorld } from "./s3/helpers/harness.mjs";
import { CHANGED_REPORT, CLEAN_REPORT, DRIFT, IN_SYNC, nativePath } from "./s3/helpers/preflight-world.mjs";

const WORKFLOW_FILE = {
  "docs-to-hub": "cascade-mechanical-docs-to-hub.lock.yml",
  "lab-to-hub": "cascade-ai-lab-to-hub.lock.yml",
  "pipelines-to-hub": "cascade-ai-pipelines-to-hub.lock.yml",
  "course-to-hub": "cascade-ai-course-to-hub.lock.yml",
  "orchestrator-to-hub": "cascade-mechanical-orchestrator-to-hub.lock.yml",
  "config-to-registry": "cascade-mechanical-config-to-registry.lock.yml",
};
const fleet = presetManifest();
const edges = presetEdges();
const matrix = routerMatrixEntries();
const declaredOf = (entry) => edges.find((edge) => edge.edgeId === entry.edgeId);
const CENTRAL = edges.find((edge) => edge.edgeId === "orchestrator-to-hub").upstreamRepo;
const MAIN = sha("examples-downstream-main");
const ETAG = 'W/"examples-head"';
const headOf = (entry) => sha(`examples-head-of-${entry.upstreamKey}`);
const expanded = (command) => command.replaceAll("<checkout>", '"$UPSTREAM_DIR"');
const exact = (text) => new RegExp(`^${text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`);
const scriptOf = (command) => /\$GITHUB_WORKSPACE\/([^"]+\.mjs)/.exec(command)?.[1];
const scriptPaths = [...new Set(edges.flatMap((edge) => [...edge.preflightCommands, ...(edge.preflightChecks ?? []).map((check) => check.classifier ?? "")]).map(scriptOf).filter(Boolean))];
const scripts = Object.fromEntries(scriptPaths.map((file) => [file, fs.readFileSync(presetAbs(file), "utf8")]));

// The helper's fixture uses the legacy spelling; examples/ declares the downstream dialect.
const fleetState = (entry, overrides = {}) =>
  Object.fromEntries(Object.entries(state({ portfolioMainSha: MAIN, ...overrides }, entry)).map(([key, value]) => [key === "portfolioMainSha" ? "downstreamMainSha" : key, value]));

function world(t, entry, { stored, downstream = {} } = {}) {
  const w = routerWorld({
    central: CENTRAL,
    edge: entry,
    manifestEdges: edges,
    manifestExtra: { factory: fleet.factory, state: fleet.state },
    state: stored ?? fleetState(entry),
    upstream: { head: headOf(entry), etag: ETAG, pullsEtag: ETAG },
    downstream: { head: MAIN, ...downstream },
    workspaceFiles: scripts,
  });
  t.after(() => w.cleanup());
  return w;
}

/** Answers of THESE declared checks: a report, a source helper, a runs listing, or a plain git diff. */
function preflight(entry, changes = entry.preflightCommands.map(() => true)) {
  const declared = declaredOf(entry);
  const answers = entry.preflightCommands.map((command, index) => {
    const report = entry.edgeId === "lab-to-hub" && index === 0;
    const listing = entry.edgeId === "pipelines-to-hub";
    const stdout = report ? (changes[index] ? CHANGED_REPORT : CLEAN_REPORT)
      : listing ? JSON.stringify({ total_count: 1, workflow_runs: [{ id: changes[index] ? 41 : 40, name: "build", status: "completed", conclusion: "success" }] })
        : command.startsWith("git ") ? "" : JSON.stringify(changes[index] ? DRIFT : IN_SYNC);
    return { match: exact(expanded(command)), code: report ? 1 : listing ? 0 : Number(changes[index]), stdout };
  });
  const classifiers = (declared.preflightChecks ?? []).flatMap((check, index) => check.classifier ? [{
    match: exact(expanded(check.classifier)),
    code: Number(changes[index]),
    then: ({ env }) => {
      assert.equal(env.SDLC_PREFLIGHT_INDEX, String(index));
      assert.equal(env.SDLC_PREFLIGHT_COMMAND, declared.preflightCommands[index]);
      assert.equal(env.SDLC_PREFLIGHT_EXIT_CODE, String(answers[index].code));
      assert.equal(fs.readFileSync(nativePath(env.SDLC_PREFLIGHT_STDOUT_FILE), "utf8"), answers[index].stdout);
      assert.equal(fs.readFileSync(nativePath(env.SDLC_PREFLIGHT_STDERR_FILE), "utf8"), "");
    },
  }] : []);
  return fakePreflight([...answers, ...classifiers]);
}

function assertDecision(w, entry, action, dispatchedWorkflowId = null, previousSha = entry.initialBaselineSha) {
  assert.deepEqual(w.decisions(), [{
    correlationId: "run-5001-1", upstreamRepo: entry.upstreamRepo, previousSha,
    targetSha: headOf(entry), action, dispatchedWorkflowId,
  }]);
}

function assertOwnWrite(w, entry) {
  assert.deepEqual(w.patches().map((patch) => patch.path), [`/repos/${CENTRAL}/actions/variables/${entry.stateVariable}`]);
  assert.deepEqual(w.stub.world.writes.map((write) => write.name), [entry.stateVariable]);
}

// Expected scopes come from the manifest, not from the production scope-selection function.
function scopeOf(entry, changes) {
  const checks = declaredOf(entry).preflightChecks ?? entry.preflightCommands.map(() => ({}));
  const scopes = [...new Set(checks.filter((_, index) => changes[index] || !changes.some(Boolean)).map((check) => check.scope).filter(Boolean))];
  return scopes.length === 1 ? scopes[0] : "both";
}

function assertDispatch(w, entry, scope) {
  const mechanical = entry.mode === "mechanical";
  const file = WORKFLOW_FILE[entry.edgeId];
  assertDecision(w, entry, mechanical ? "dispatch-mechanical" : "dispatch-ai-adaptation", file);
  assert.equal(w.stub.world.dispatches.length, 1);
  const [dispatch] = w.stub.world.dispatches;
  assert.equal(dispatch.file, file);
  const { inputs } = dispatch.body;
  assert.equal(Object.keys(inputs).length, mechanical ? 8 : 10);
  for (const value of Object.values(inputs)) assert.equal(typeof value, "string");
  assert.equal(inputs.previous_sha, entry.initialBaselineSha, "dispatch from the merge cursor, not the observed head");
  assert.equal(inputs.upstream_sha, headOf(entry));
  assert.equal(inputs.upstream_repo, entry.upstreamRepo);
  assert.equal(inputs.downstream_repo, entry.downstreamRepo);
  if (!mechanical) {
    assert.equal(inputs.sync_scope, scope);
    assert.equal(inputs.on_commit_only_advance, entry.onCommitOnlyAdvance);
  }
  assert.equal(w.state().inFlightTargetSha, headOf(entry));
  assert.equal(w.state().inFlightRunId, dispatch.runId);
  assert.equal(w.state().lastMergedUpstreamSha, entry.initialBaselineSha);
  assert.equal(w.state().lastNoopHeadSha, null);
  assertOwnWrite(w, entry);
}

test("examples matrix: six committed edges in manifest order and existing dispatch locks", () => {
  assert.deepEqual(matrix.map((entry) => entry.edgeId), Object.keys(WORKFLOW_FILE));
  assert.deepEqual(matrix.map((entry) => entry.edgeId), edges.map((edge) => edge.edgeId));
  for (const entry of matrix) {
    // Renderer defaults absent from the manifest (such as onBots) belong to the renderer tests.
    for (const [key, value] of Object.entries(entry).filter(([key]) => Object.hasOwn(declaredOf(entry), key))) assert.deepEqual(value, declaredOf(entry)[key], `${entry.edgeId}/${key}`);
    assert.ok(fs.statSync(presetAbs(".github", "workflows", WORKFLOW_FILE[entry.edgeId])).isFile(), entry.edgeId);
  }
});

for (const entry of matrix) {
  test(`examples dispatch: ${entry.edgeId}`, async (t) => {
    const w = world(t, entry);
    const fake = preflight(entry);
    const result = await w.go({ preflightDeps: fake.deps });
    assert.equal(result.code, 0, result.stderr);
    assertDispatch(w, entry, scopeOf(entry, entry.preflightCommands.map(() => true)));
  });
}

const TERMINAL = [
  ["already-merged", "noop-304", (head) => ({ lastMergedUpstreamSha: head })],
  ["already-noop", "noop-304", (head) => ({ lastNoopHeadSha: head })],
  ["dismissed", "noop-dismissed-pr", (head) => ({ dismissedTargetSha: head })],
  ["blocked", "noop-blocked-sha", (head) => ({ failedTargetSha: head, failedAttempts: 2, blockedTargetSha: head })],
  ["in-flight", "noop-304", (head) => ({ inFlightRunId: 4242, inFlightTargetSha: head })],
  ["open-pr-covers", "noop-304", (head) => ({ openPrNumber: 7, openPrTargetSha: head })],
];

for (const entry of matrix) {
  test(`examples terminal: ${entry.edgeId}`, async (t) => {
    for (const [label, action, overrides] of TERMINAL) {
      const head = headOf(entry);
      // A conditional poll has nothing new to persist; this isolates each terminal comparison's effects.
      const stored = fleetState(entry, { etag: ETAG, lastObservedHeadSha: head, ...overrides(head) });
      const downstream = {
        ...(label === "already-merged" ? { files: { [entry.provenanceFile]: JSON.stringify({ commit: head }) } } : {}),
        ...(label === "open-pr-covers" ? { pulls: { 7: {
          number: 7, state: "open", merged: false, html_url: `https://github.com/${entry.downstreamRepo}/pull/7`,
          head: { ref: entry.branchName, sha: sha("examples-pr-head") },
        } } } : {}),
      };
      const w = world(t, entry, { stored, downstream });
      w.stub.repo(CENTRAL, { runs: { 4242: { id: 4242, status: "queued", conclusion: null } } });
      const fake = preflight(entry);
      const result = await w.go({ preflightDeps: fake.deps });
      assert.equal(result.code, 0, `${label}: ${result.stderr}`);
      assertDecision(w, entry, action, null, stored.lastMergedUpstreamSha);
      assert.deepEqual(w.stub.world.dispatches, [], label);
      assert.deepEqual(fake.calls, [], `${label}: no preflight process`);
      assert.deepEqual(fake.checkouts, [], `${label}: no checkout`);
      assert.deepEqual(w.stub.requests.filter((request) => request.method !== "GET" && !request.path.startsWith("/app/")), [], `${label}: only the token exchange may write`);
      assert.deepEqual(w.state(), stored, `${label}: the variable is untouched`);
    }
  });
}

test("examples seed: every edge has the fixture fields and its own baseline", () => {
  const seed = readJson(fixture("state", "valid-seed.json"));
  for (const entry of matrix) {
    const actual = state({}, entry);
    assert.deepEqual(Object.keys(actual), Object.keys(seed));
    assert.deepEqual(actual, { ...seed, lastObservedHeadSha: entry.initialBaselineSha, lastMergedUpstreamSha: entry.initialBaselineSha, updatedAt: NOW_ISO });
  }
});

for (const entry of matrix.filter((edge) => edge.mode === "ai-adaptation")) {
  test(`examples preflight: ${entry.edgeId}`, async (t) => {
    const commands = entry.preflightCommands;
    // Quiet, then each check drifting alone; the dispatch test above also covers both lab checks drifting.
    const cases = [commands.map(() => false), ...commands.map((_, changed) => commands.map((__, index) => index === changed))];
    for (const changes of cases) {
      const w = world(t, entry);
      const fake = preflight(entry, changes);
      const result = await w.go({ preflightDeps: fake.deps });
      assert.equal(result.code, 0, `${changes}: ${result.stderr}`);
      const classifiers = (declaredOf(entry).preflightChecks ?? []).flatMap((check) => check.classifier ? [check.classifier] : []);
      assert.deepEqual(fake.scripts(), [
        ...(commands.some((command) => /^\s*(npm|npx)\s/.test(command)) ? ["npm ci --include=dev --ignore-scripts"] : []),
        ...commands.map(expanded), ...classifiers.map(expanded),
      ]);
      assert.deepEqual(fake.checkouts.map((checkout) => [checkout.slug, checkout.sha]), [
        [entry.upstreamRepo, headOf(entry)],
        ...(commands.some((command) => !/^\s*git\s/.test(command)) ? [[entry.downstreamRepo, MAIN]] : []),
      ]);
      if (changes.some(Boolean) || entry.onCommitOnlyAdvance === "bump-provenance") {
        // course-to-hub deliberately dispatches even at git exit 0: a commit-only advance bumps provenance.
        assertDispatch(w, entry, scopeOf(entry, changes));
      } else {
        const noop = declaredOf(entry).preflightChecks?.find((check) => check.noopAction)?.noopAction ?? "noop-no-material-drift";
        assertDecision(w, entry, noop);
        assert.deepEqual(w.stub.world.dispatches, []);
        assert.equal(w.state().lastNoopHeadSha, headOf(entry));
        assert.equal(w.state().lastObservedHeadSha, headOf(entry));
        assert.equal(w.state().etag, ETAG);
        assert.equal(w.state().lastMergedUpstreamSha, entry.initialBaselineSha);
        assert.equal(w.state().inFlightRunId, null);
        assert.equal(w.state().inFlightTargetSha, null);
        assertOwnWrite(w, entry);
      }
      for (const call of fake.calls.filter((call) => call.env.SDLC_PREFLIGHT_STDOUT_FILE)) {
        assert.equal(fs.existsSync(nativePath(call.env.SDLC_PREFLIGHT_STDOUT_FILE)), false, "the classifier's report file is removed");
        assert.equal(fs.existsSync(nativePath(call.env.SDLC_PREFLIGHT_STDERR_FILE)), false);
      }
    }
  });
}
