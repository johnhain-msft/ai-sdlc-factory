// Exercise upkeep options through mixed fleets and the public reconcile CLI, including removal and refusal without writes.
import assert from "node:assert/strict";
import test from "node:test";
import { renderFleet } from "../../src/reconcile.mjs";
import { minimalManifest, parseWorkflow, referenceRequest, toYaml } from "./helpers/fixtures.mjs";
import { createWorkspace } from "./helpers/workspace.mjs";

const sourcePath = (id) => `.github/workflows/${id}.md`;
const workflowOnDisk = (workspace, id) => parseWorkflow(workspace.read(sourcePath(id)));
const errorsOf = (outcome) => outcome.json.validationResults.flatMap((entry) => entry.errors);

function runCli(workspace, request = referenceRequest()) {
  const file = workspace.path("request.json");
  workspace.write("request.json", JSON.stringify(request));
  return workspace.cli(file);
}

function chainManifest() {
  const manifest = minimalManifest();
  const [alpha, beta] = manifest.projects;
  const gamma = structuredClone(alpha);
  gamma.projectKey = "gamma-service";
  gamma.repo = "example-org/gamma-service";
  gamma.driftAudit.changePolicy = "judgement-and-flag";
  alpha.driftAudit.model = "alpha-model";
  beta.driftAudit = {
    ...structuredClone(alpha.driftAudit),
    changePolicy: "corrections-and-additions",
    model: "beta-model",
  };
  manifest.projects.push(gamma);
  const first = manifest.dependencyEdges[0];
  first.model = "cascade-model";
  first.agentSandbox = { bashCommands: ["jq"] };
  manifest.dependencyEdges.push({
    ...structuredClone(first),
    edgeId: "beta-to-gamma",
    upstreamRepo: beta.repo,
    upstreamKey: beta.projectKey,
    upstreamSlug: "BETA_DOCS",
    upstreamDefaultBranch: beta.defaultBranch,
    downstreamRepo: gamma.repo,
    mode: "ai-adaptation",
    stateVariable: `${referenceRequest().pollStateVarPrefix}BETA_DOCS`,
    branchName: "sdlc/cascade-beta-to-gamma",
    closeOlderKey: "sdlc-cascade-beta-to-gamma",
    agentSandbox: { bashCommands: ["sed"] },
  });
  delete manifest.dependencyEdges[1].model;
  return manifest;
}

test("upkeep options stay local to each project and edge when a mixed fleet is reordered", () => {
  const manifest = chainManifest();
  const workspace = createWorkspace({ manifestText: toYaml(manifest) });
  try {
    const first = renderFleet(referenceRequest(), { cwd: workspace.dir });
    assert.ok(first.ok, JSON.stringify(first.result));
    const workflow = (id) => parseWorkflow(first.files.get(sourcePath(id)));
    assert.equal([...first.files.keys()].filter((file) => file.endsWith(".md")).length, 9);
    for (const [key, policy, model, additions, judgement] of [
      ["alpha-service", "corrections-only", "alpha-model", false, false],
      ["beta-docs", "corrections-and-additions", "beta-model", true, false],
      ["gamma-service", "judgement-and-flag", undefined, true, true],
    ]) {
      const drift = workflow(`drift-${key}`);
      const implement = workflow(`implement-${key}`);
      assert.ok(drift.body.includes(`## Change policy: ${policy}\n`), key);
      const recommended = drift.body.split("\n").find((line) => line.startsWith("- `## Recommended`: "));
      assert.equal(/addition/.test(recommended), additions, `${key}: recommendations`);
      assert.equal(/judgement call/.test(recommended), judgement, `${key}: recommendations`);
      assert.equal(drift.body.includes("- `## For a human`: "), !judgement, key);
      assert.equal(implement.body.includes("## Judgement calls — review these"), judgement, key);
      assert.equal(drift.frontmatter.engine.model, model, key);
      assert.deepEqual(implement.frontmatter.engine, drift.frontmatter.engine, key);
    }
    for (const [id, model, allowed, other] of [
      ["cascade-mechanical-alpha-to-beta", "cascade-model", "jq", "sed"],
      ["cascade-ai-beta-to-gamma", undefined, "sed", "jq"],
    ]) {
      const { frontmatter } = workflow(id);
      assert.equal(frontmatter.engine.model, model, id);
      assert.ok(frontmatter.tools.bash.includes(allowed), id);
      assert.equal(frontmatter.tools.bash.includes(other), false, `${id}: no sibling extension`);
      assert.ok(frontmatter.tools.bash.includes("cd"), id);
    }
    assert.equal(workflow("sdlc-onboard").frontmatter.engine.model, undefined);
    manifest.projects.reverse();
    manifest.dependencyEdges.reverse();
    workspace.write("sdlc.yaml", toYaml(manifest));
    const reordered = renderFleet(referenceRequest(), { cwd: workspace.dir });
    assert.ok(reordered.ok, JSON.stringify(reordered.result));
    for (const [file, text] of first.files) {
      if (file.endsWith(".md")) assert.equal(reordered.files.get(file), text, `${file}: no iteration-order leakage`);
    }
  } finally {
    workspace.cleanup();
  }
});

test("the reconcile CLI persists changed upkeep options and removes them back to byte-identical defaults", () => {
  const manifest = minimalManifest();
  manifest.dependencyEdges[0].mode = "ai-adaptation";
  const workspace = createWorkspace({ manifestText: toYaml(manifest) });
  try {
    const initial = runCli(workspace);
    assert.equal(initial.code, 0, `${initial.stdout}${initial.stderr}`);
    const baseline = workspace.hash();
    const audit = manifest.projects[0].driftAudit;
    const edge = manifest.dependencyEdges[0];
    for (const policy of ["corrections-and-additions", "judgement-and-flag"]) {
      audit.changePolicy = policy;
      audit.model = "project/model-v2";
      edge.model = "cascade/model-v3";
      edge.agentSandbox = { bashCommands: ["jq", "git", "cd"] };
      workspace.write("sdlc.yaml", toYaml(manifest));
      const beforeDryRun = workspace.hash();
      const dry = runCli(workspace, { ...referenceRequest(), dryRun: true });
      assert.equal(dry.code, 0, `${dry.stdout}${dry.stderr}`);
      assert.equal(workspace.hash(), beforeDryRun, `${policy}: a preview changes no generated file`);
      const emitted = runCli(workspace);
      assert.equal(emitted.code, 0, `${emitted.stdout}${emitted.stderr}`);
      for (const kind of ["drift", "implement"]) {
        const id = `${kind}-alpha-service`;
        const workflow = workflowOnDisk(workspace, id);
        assert.equal(workflow.frontmatter.engine.model, audit.model, `${policy}: ${id}`);
        assert.equal(workflow.body.includes("## Judgement calls — review these"), policy === "judgement-and-flag", id);
        assert.ok(workspace.exists(`.github/workflows/${id}.lock.yml`), `${id}: compiled artifact exists`);
      }
      assert.ok(workflowOnDisk(workspace, "drift-alpha-service").body.includes(`## Change policy: ${policy}\n`));
      const cascade = workflowOnDisk(workspace, "cascade-ai-alpha-to-beta");
      assert.equal(cascade.frontmatter.engine.model, edge.model);
      assert.ok(cascade.frontmatter.tools.bash.includes("jq"));
      assert.equal(cascade.frontmatter.tools.bash.filter((word) => word === "cd").length, 1);
      assert.equal(cascade.frontmatter.tools.bash.filter((word) => word === "git").length, 1);
      const snapshot = workspace.hash();
      const repeat = runCli(workspace);
      assert.equal(repeat.code, 0, `${repeat.stdout}${repeat.stderr}`);
      assert.equal(workspace.hash(), snapshot, `${policy}: repeat is idempotent`);
    }
    delete audit.changePolicy;
    delete audit.model;
    delete edge.model;
    delete edge.agentSandbox;
    workspace.write("sdlc.yaml", toYaml(manifest));
    const removed = runCli(workspace);
    assert.equal(removed.code, 0, `${removed.stdout}${removed.stderr}`);
    assert.equal(workspace.hash(), baseline, "removal restores all default sources and locks, not stale models or tools");
  } finally {
    workspace.cleanup();
  }
});

test("the reconcile CLI refuses invalid new schema options before compilation and preserves an existing fleet", () => {
  const manifest = minimalManifest();
  const workspace = createWorkspace({ manifestText: toYaml(manifest) });
  try {
    const initial = runCli(workspace);
    assert.equal(initial.code, 0, `${initial.stdout}${initial.stderr}`);
    const baseline = workspace.hash();
    const cases = [
      ["/projects/0/driftAudit/changePolicy", (copy) => (copy.projects[0].driftAudit.changePolicy = "apply-everything")],
      ["/projects/0/driftAudit/model", (copy) => (copy.projects[0].driftAudit.model = "")],
      ["/dependencyEdges/0/model", (copy) => (copy.dependencyEdges[0].model = "m".repeat(129))],
      ["/dependencyEdges/0/agentSandbox", (copy) => (copy.dependencyEdges[0].agentSandbox = { installDependencies: true })],
      ["/dependencyEdges/0/agentSandbox/bashCommands", (copy) => (copy.dependencyEdges[0].agentSandbox = { bashCommands: ["jq --raw-output"] })],
      ["/dependencyEdges/0/agentSandbox/bashCommands", (copy) => (copy.dependencyEdges[0].agentSandbox = { bashCommands: ["jq", "jq"] })],
    ];
    for (const [pointer, change] of cases) {
      const invalid = structuredClone(manifest);
      change(invalid);
      workspace.write("sdlc.yaml", toYaml(invalid));
      workspace.shims.reset();
      const refused = runCli(workspace);
      assert.equal(refused.code, 1, `${pointer}: ${refused.stdout}${refused.stderr}`);
      assert.ok(errorsOf(refused).some((error) => error.startsWith("schema-validation: ") && error.includes(pointer)), refused.stdout);
      assert.deepEqual(refused.json.generatedWorkflows, []);
      assert.equal(workspace.shims.calls("gh").length, 0, `${pointer}: no compiler or remote operation`);
      assert.equal(workspace.hash(), baseline, `${pointer}: previous sources and locks survive`);
    }
  } finally {
    workspace.cleanup();
  }
});

test("the reconcile CLI refuses a mixed-case network command on a later edge of a nested manifest without writes", () => {
  const manifest = chainManifest();
  const workspace = createWorkspace({ manifestText: toYaml(manifest) });
  const request = { ...referenceRequest(), manifestPath: "config/fleet.yaml" };
  try {
    for (const mode of ["mechanical", "ai-adaptation"]) {
      const edge = manifest.dependencyEdges[1];
      edge.mode = mode;
      edge.agentSandbox = { bashCommands: ["jq", "sed"] };
      workspace.write(request.manifestPath, toYaml(manifest));
      const initial = runCli(workspace, request);
      assert.equal(initial.code, 0, `${initial.stdout}${initial.stderr}`);
      const baseline = workspace.hash();
      edge.agentSandbox.bashCommands.push("WgEt");
      workspace.write(request.manifestPath, toYaml(manifest));
      workspace.shims.reset();
      const refused = runCli(workspace, request);
      assert.equal(refused.code, 1, `${refused.stdout}${refused.stderr}`);
      assert.deepEqual(errorsOf(refused), [
        "drift-bash-command-forbidden: edge 'beta-to-gamma' (config/fleet.yaml#/dependencyEdges/1/agentSandbox/bashCommands/2): 'WgEt' reaches the network or the GitHub API, and a cascade agent publishes only through its create_pull_request safe output",
      ]);
      assert.deepEqual(refused.json.generatedWorkflows, []);
      assert.equal(workspace.shims.calls("gh").length, 0, `${mode}: neither compile nor publish`);
      assert.equal(workspace.hash(), baseline, `${mode}: existing artifacts stay byte for byte`);
      assert.ok(workspace.exists(sourcePath(`cascade-${mode === "mechanical" ? "mechanical" : "ai"}-beta-to-gamma`)));
    }
  } finally {
    workspace.cleanup();
  }
});
