// Delta-only QA for the AC14/AC22 fixes and for the declared preflight checks. The REST side is the in-process fake.fetch; the commands of a preflight are answered
// by the fake of tests/s3/helpers/fake-preflight.mjs (tests/s3/helper-cli-consumer.test.mjs runs them as real processes).
import assert from "node:assert/strict";
import test from "node:test";
import { initialSyncState } from "../../bin/lib/actions-variables.mjs";
import { mechanicalEdge, NOW_ISO, sha, state } from "./helpers/fixtures.mjs";
import { fakePreflight } from "./helpers/fake-preflight.mjs";
import { routerWorld } from "./helpers/harness.mjs";
import { CHANGED_REPORT, CLEAN_REPORT, DRIFT, IN_SYNC, preflightEdge, STAND_IN_SCRIPTS } from "./helpers/preflight-world.mjs";

const json = (value) => `${JSON.stringify(value)}\n`;
const report = (code, stdout) => ({ match: /check:inputs/, code, stdout });
const helper = (code, stdout, stderr = "") => ({ match: /check-drift\.mjs/, code, stdout: typeof stdout === "string" ? stdout : json(stdout), stderr });
const classifier = (code) => ({ match: /classify\.mjs/, code });

test("QA3 historical provenance refusal is side-effect-free on retry and recovers when the configured file is restored", async (t) => {
  const edge = mechanicalEdge({ initialBaselineSha: sha("qa3-bootstrap"), preflightCommands: [] });
  const first = sha("qa3-merged");
  const second = sha("qa3-next-target");
  const world = routerWorld({
    edge,
    state: initialSyncState(edge.initialBaselineSha, NOW_ISO),
    upstream: { head: first },
    downstream: { files: { [edge.provenanceFile]: JSON.stringify({ commit: first }) } },
  });
  t.after(() => world.cleanup());

  // Main's authoritative provenance can advance the seeded cursor without a
  // recorded open PR. That also ends the bootstrap fallback.
  const observed = await world.go();
  assert.equal(observed.code, 0, observed.stderr);
  assert.equal(world.state().lastMergedUpstreamSha, first);
  assert.notEqual(first, edge.initialBaselineSha);
  assert.equal(world.stub.world.dispatches.length, 0);
  const before = world.stub.variables.get(edge.stateVariable);
  const patches = world.patches().length;
  const decisions = world.decisions().length;

  world.stub.repo(edge.downstreamRepo, { head: sha("qa3-main-deleted"), files: {} });
  world.stub.repo(edge.upstreamRepo, { head: second, etag: 'W/"qa3-next"' });
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const refused = await world.go();
    assert.equal(refused.code, 1, `${refused.stderr}\n${refused.stdout}`);
    assert.match(refused.stderr, /has moved off the seed/);
    assert.equal(world.stub.variables.get(edge.stateVariable), before);
    assert.equal(world.patches().length, patches);
    assert.equal(world.decisions().length, decisions);
    assert.equal(world.stub.world.dispatches.length, 0);
  }
  assert.equal(world.stub.issues.length, 1, "retry comments instead of duplicating the diagnostic issue");
  assert.equal(world.stub.world.comments.length, 1);

  world.stub.repo(edge.downstreamRepo, {
    head: sha("qa3-main-restored"),
    files: { [edge.provenanceFile]: JSON.stringify({ commit: first }) },
  });
  const repaired = await world.go();
  assert.equal(repaired.code, 0, repaired.stderr);
  assert.equal(world.stub.world.dispatches.length, 1);
  const inputs = world.stub.world.dispatches[0].body.inputs;
  assert.equal(inputs.previous_sha, first, "resume the cumulative merged cursor, never the seed or a failed observation");
  assert.equal(inputs.upstream_sha, second);
  assert.equal(world.state().inFlightTargetSha, second);
  assert.equal(world.state().lastMergedUpstreamSha, first);
  assert.equal(world.state().etag, JSON.parse(before).etag, "the dispatch still holds fresh poll observations in memory");
  assert.equal(world.state().lastObservedHeadSha, first);
  assert.equal(world.patches().length, patches + 1);
  assert.equal(world.decisions().length, decisions + 1);
});

test("QA3 a failed check is side-effect-free on retry, comments instead of duplicating its issue, and the router dispatches once the check is repaired", async (t) => {
  const merged = sha("qa3-merged");
  const edge = preflightEdge({ initialBaselineSha: merged });
  const head = sha("qa3-head");
  const w = routerWorld({ edge, state: state({ lastMergedUpstreamSha: merged, lastObservedHeadSha: merged }, edge), upstream: { head }, downstream: { head: sha("qa3-main") }, workspaceFiles: STAND_IN_SCRIPTS });
  t.after(() => w.cleanup());
  const before = w.stub.variables.get(edge.stateVariable);

  for (let attempt = 0; attempt < 2; attempt += 1) {
    const fake = fakePreflight([report(0, CLEAN_REPORT), classifier(0), helper(2, "", "fatal: cannot read the sources\n")]);
    const refused = await w.go({ preflightDeps: fake.deps });
    assert.equal(refused.code, 1, `${refused.stderr}\n${refused.stdout}`);
    assert.match(refused.stderr, /exited with 2: fatal: cannot read the sources/);
    assert.equal(w.stub.variables.get(edge.stateVariable), before, "the variable is as it was");
    assert.equal(w.patches().length, 0);
    assert.equal(w.decisions().length, 0);
    assert.equal(w.stub.world.dispatches.length, 0);
  }
  assert.equal(w.stub.issues.length, 1, "retry comments instead of duplicating the diagnostic issue");
  assert.equal(w.stub.world.comments.length, 1);

  const fake = fakePreflight([report(0, CLEAN_REPORT), classifier(0), helper(1, DRIFT)]);
  const repaired = await w.go({ preflightDeps: fake.deps });
  assert.equal(repaired.code, 0, repaired.stderr);
  assert.equal(w.stub.world.dispatches.length, 1);
  const inputs = w.stub.world.dispatches[0].body.inputs;
  assert.equal(inputs.previous_sha, merged, "the cumulative merged cursor, never a failed observation");
  assert.equal(inputs.upstream_sha, head);
  assert.equal(inputs.sync_scope, "app-only");
  assert.equal(w.state().inFlightTargetSha, head);
  assert.equal(w.state().lastMergedUpstreamSha, merged);
  assert.equal(w.patches().length, 1);
});

test("QA3 several checks that drift make one dispatch whose inputs are those of any other dispatch, with the scope that covers them", async (t) => {
  const merged = sha("qa3-merged");
  const edge = preflightEdge({ initialBaselineSha: merged });
  const head = sha("qa3-head");
  const build = (overrides = {}) =>
    routerWorld({ edge: { ...edge, ...overrides }, state: state({ lastMergedUpstreamSha: merged, lastObservedHeadSha: merged }, edge), upstream: { head }, downstream: { head: sha("qa3-main") }, workspaceFiles: STAND_IN_SCRIPTS });

  // the same edge without any preflight is the reference for the shape of a dispatch
  const plain = build({ preflightCommands: [], preflightChecks: undefined });
  t.after(() => plain.cleanup());
  assert.equal((await plain.go()).code, 0);
  assert.equal(plain.stub.world.dispatches.length, 1);
  const referenceKeys = Object.keys(plain.stub.world.dispatches[0].body.inputs).sort();

  const world = build();
  t.after(() => world.cleanup());
  const fake = fakePreflight([report(1, CHANGED_REPORT), classifier(1), helper(1, DRIFT)]);
  const result = await world.go({ preflightDeps: fake.deps });
  assert.equal(result.code, 0, result.stderr);
  assert.equal(world.stub.world.dispatches.length, 1, "two drifted checks are still one dispatch");
  const inputs = world.stub.world.dispatches[0].body.inputs;
  assert.deepEqual(Object.keys(inputs).sort(), referenceKeys);
  assert.ok(Object.values(inputs).every((value) => typeof value === "string"));
  assert.equal(inputs.sync_scope, "both", "docs-only and app-only drifted, so the scope that covers both");
  assert.equal(world.state().inFlightTargetSha, head);
  assert.equal(world.state().lastNoopHeadSha, null);
  assert.equal(world.state().lastMergedUpstreamSha, merged);
  assert.equal(world.patches().length, 1);
  assert.equal(world.decisions().length, 1);
  assert.equal(world.decisions()[0].action, "dispatch-ai-adaptation");
  assert.ok(result.stdout.split("\n").some((line) => line.includes("dispatch-ai-adaptation")) || world.summaryLines().length === 1, "the decision is logged once");
  assert.deepEqual(IN_SYNC.changed, [], "the in-sync answer is the neutral one");
});
