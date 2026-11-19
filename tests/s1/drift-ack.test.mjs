// AC26: the DriftWorkflowCompileAck of contract C2, returned by buildAcks(request).drift.
import assert from "node:assert/strict";
import test from "node:test";
import { buildAcks, renderFleet } from "../../src/reconcile.mjs";
import { minimalManifest, mutate, parseWorkflow, PRESET_ROOT, presetManifest, projectOf, referenceRequest, toYaml, withRequest } from "./helpers/fixtures.mjs";
import { fillCommand } from "./helpers/factory.mjs";
import { createWorkspace } from "./helpers/workspace.mjs";

const request = referenceRequest();

test("AC26: for the preset buildAcks(request).drift has three entries in projects[] order with values derived from sdlc.yaml", () => {
  const manifest = presetManifest();
  const { drift } = buildAcks(request, { cwd: PRESET_ROOT });
  const enabled = manifest.projects.filter((project) => project.driftAudit.enabled);
  assert.equal(drift.length, 3);
  assert.deepEqual(drift.map((ack) => ack.workflowId), enabled.map((project) => `drift-${project.projectKey}`));
  drift.forEach((ack, index) => {
    const project = enabled[index];
    assert.deepEqual(Object.keys(ack).sort(), ["allowedNetworkDomains", "gateCommands", "lockPath", "targetRepo", "workflowId"]);
    assert.equal(ack.workflowId, `drift-${project.projectKey}`);
    assert.equal(ack.lockPath, `.github/workflows/drift-${project.projectKey}.lock.yml`);
    assert.equal(ack.targetRepo, project.repo);
    assert.deepEqual(ack.gateCommands, project.driftAudit.verifyCommands);
    assert.ok(ack.allowedNetworkDomains.length > 0);
  });
});

test("AC26: allowedNetworkDomains is network.allowed as rendered and gateCommands is the rendered post-steps command list", () => {
  const rendered = renderFleet(request, { cwd: PRESET_ROOT });
  assert.ok(rendered.ok);
  for (const ack of buildAcks(request, { cwd: PRESET_ROOT }).drift) {
    const { frontmatter } = parseWorkflow(rendered.files.get(`.github/workflows/${ack.workflowId}.md`));
    assert.deepEqual(ack.allowedNetworkDomains, frontmatter.network.allowed);
    assert.deepEqual(ack.gateCommands.map(fillCommand), frontmatter["post-steps"].map((step) => step.run));
  }
});

test("AC26: a manifest with no drift-enabled project yields an empty list; a disabled project is skipped", () => {
  const workspace = createWorkspace({ manifestText: toYaml(minimalManifest()) });
  try {
    assert.deepEqual(buildAcks(request, { cwd: workspace.dir }).drift.map((ack) => ack.workflowId), ["drift-alpha-service"]);
  } finally {
    workspace.cleanup();
  }
  const none = mutate(minimalManifest(), (copy) => (projectOf(copy, "alpha-service").driftAudit.enabled = false));
  const second = createWorkspace({ manifestText: toYaml(none) });
  try {
    assert.deepEqual(buildAcks(request, { cwd: second.dir }).drift, []);
  } finally {
    second.cleanup();
  }
});

test("AC26: buildAcks renders without writing any file — the working tree hash is unchanged by the call", async () => {
  const workspace = createWorkspace();
  try {
    workspace.write(".github/workflows/ci.yml", "name: operator workflow\non: push\n");
    const before = workspace.hash(["."]);
    const acks = buildAcks(request, { cwd: workspace.dir });
    assert.equal(acks.drift.length, 3);
    assert.equal(workspace.hash(["."]), before);
    assert.equal(workspace.shims.log().length, 0, "no process is spawned");
  } finally {
    workspace.cleanup();
  }
});

test("AC26: buildAcks is synchronous and throws an Error carrying validationResults for an invalid request", () => {
  const outcome = buildAcks(request, { cwd: PRESET_ROOT });
  assert.equal(typeof outcome.then, "undefined", "not a promise");
  assert.throws(
    () => buildAcks(withRequest({ appSlug: "bad slug]" }), { cwd: PRESET_ROOT }),
    (error) => error instanceof Error && Array.isArray(error.validationResults) && error.validationResults[0].file === "BootstrapReconcileRequest",
  );
});
