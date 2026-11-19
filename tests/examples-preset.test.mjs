// examples/sdlc.yaml is the engine's own preset (design H): nine projects, six edges, and a feature kept by each of them. Every test that is repointed at the
// preset leans on one of those features, so the structure is pinned here: a change of the fleet that drops a feature fails in the commit that makes it,
// and not as a silent loss of coverage in a test that happens to keep passing. This file reads examples/ itself, never the SDLC_PRESET_ROOT seam.
import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import Ajv from "ajv";
import YAML from "yaml";
import { engineAbs } from "./helpers/preset.mjs";
import { globMatches } from "./s1/helpers/fixtures.mjs";

const read = (...parts) => fs.readFileSync(engineAbs("examples", ...parts), "utf8");
const manifest = YAML.parse(read("sdlc.yaml"));
const projectOf = (key) => manifest.projects.find((project) => project.projectKey === key);
const edgeOf = (id) => manifest.dependencyEdges.find((edge) => edge.edgeId === id);
const hostsOf = (project) => [...new Set(project.driftAudit.knowledgeSources.watchUrls.map((entry) => new URL(entry.url).host))].sort();

test("examples/sdlc.yaml validates against the schema of the package", () => {
  const validate = new Ajv({ allErrors: true, strict: true }).compile(JSON.parse(fs.readFileSync(engineAbs("schemas", "sdlc.schema.json"), "utf8")));
  assert.ok(validate(manifest), JSON.stringify(validate.errors));
});

test("the top level: a private factory, the downstream state dialect, two upkeeps, the prompt wording, the provenance names and the protected-file exception", () => {
  assert.deepEqual(Object.keys(manifest), ["factory", "state", "dedupe", "prompts", "onboarding", "protectedFilesExclude", "projects", "dependencyEdges"]);
  assert.deepEqual(manifest.factory, { package: "ai-sdlc-factory", source: "github:example-org/ai-sdlc-factory", private: true });
  assert.deepEqual(manifest.state, { dialect: "downstream" });
  assert.deepEqual(manifest.dedupe.upkeeps.map((upkeep) => upkeep.id), ["weekly-audit", "self-improve"]);
  assert.deepEqual(manifest.dedupe.strategyUpkeep, { "content-and-docs-sync": "weekly-audit", "code-quality-and-improvement-scan": "self-improve" });
  assert.deepEqual(manifest.onboarding.provenanceNames, ["source.json", "provenance.json"]);
  assert.deepEqual(manifest.protectedFilesExclude, ["/README.md"]);
  assert.equal(typeof manifest.prompts.pullRequestBodyItems, "string");
  assert.equal(manifest.prompts.reportExamples.length, 2);
});

test("nine projects, with the keys and repositories of the reference fleet; two of them share one repository", () => {
  assert.deepEqual(manifest.projects.map((project) => [project.projectKey, project.repo]), [
    ["docs-site", "example-org/docs-site"],
    ["lab-content", "example-org/lab-content"],
    ["agent-kit", "example-org/lab-content"],
    ["demo-pipelines", "example-org/demo-pipelines"],
    ["course-template", "example-org/course-template"],
    ["hub", "example-org/hub"],
    ["orchestrator", "example-org/orchestrator"],
    ["config-kit", "example-org/config-kit"],
    ["asset-registry", "example-org/asset-registry"],
  ]);
  for (const project of manifest.projects) {
    assert.equal(project.defaultBranch, "main", project.projectKey);
    assert.equal(project.deconflictInRepoSchedules, "none", project.projectKey);
  }
});

test("the drift audit is enabled for exactly the three drift projects, each with its strategy, and is off for the upstream-only and downstream projects", () => {
  assert.deepEqual(
    manifest.projects.filter((project) => project.driftAudit.enabled).map((project) => [project.projectKey, project.driftAudit.upkeepStrategy]),
    [["docs-site", "content-and-docs-sync"], ["lab-content", "content-and-docs-sync"], ["agent-kit", "code-quality-and-improvement-scan"]],
  );
  for (const key of ["demo-pipelines", "course-template", "hub", "orchestrator", "config-kit", "asset-registry"]) assert.equal(projectOf(key).driftAudit.enabled, false, key);
});

test("each drift project keeps its feature: docs-site its sandbox, hosts and builds, lab-content its staged validator and compare-then-run check, agent-kit its second use of one repository", () => {
  const docs = projectOf("docs-site").driftAudit;
  assert.deepEqual(hostsOf(projectOf("docs-site")), ["changelog.example.org", "docs.example.net"], "watch URLs on two hosts");
  assert.equal(docs.knowledgeSources.watchUrls.every((entry) => new URL(entry.url).protocol === "https:"), true);
  assert.equal(docs.agentSandbox.installDependencies, true, "the target's dependencies are installed before the agent starts");
  assert.ok(docs.agentSandbox.bashCommands.includes("jq") && docs.agentSandbox.bashCommands.includes("rg"));
  assert.ok(docs.buildCommands.length >= 1);
  assert.ok(docs.verifyCommands.some((command) => /^npm (ci|test|run)/.test(command)), "npm verify commands");

  const lab = projectOf("lab-content").driftAudit;
  assert.deepEqual(lab.stagedScripts, ["scripts/validate-example.mjs"]);
  assert.match(lab.verifyCommands[0], /cmp -s .*validate-example\.mjs[\s\S]*node "\$copy\/scripts\/validate-example\.mjs"/, "the workspace copy is compared with the staged one, and the staged copy is what runs");
  assert.doesNotMatch(lab.verifyCommands[0], /node "\$GITHUB_WORKSPACE\//, "the workspace copy is not run");
  assert.deepEqual(lab.agentSandbox, { bashCommands: ["cut", "sed"] });

  const kit = projectOf("agent-kit").driftAudit;
  assert.equal(projectOf("agent-kit").repo, projectOf("lab-content").repo);
  assert.deepEqual(kit.stagedScripts, ["scripts/validate-example.mjs"]);
  assert.ok(kit.verifyCommands.some((command) => /for f in tests\//.test(command)), "a check that names the test files it requires");
  assert.equal(kit.agentSandbox, undefined, "asks for nothing extra");

  for (const key of ["docs-site", "lab-content", "agent-kit"]) {
    const { instructionsFile } = projectOf(key).driftAudit;
    assert.equal(instructionsFile, `instructions/${key}.md`);
    assert.ok(read(instructionsFile).length < 3072, `${instructionsFile} is under 3 KB`);
  }
});

// Which edge uses which feature: the rows are what the repointed tests depend on, in the order of the manifest.
const FEATURES = {
  "docs-to-hub": {
    mode: "mechanical", upstream: "docs-site", downstream: "example-org/hub", scopes: null, commitOnly: "noop", installDirectories: [".", "apps/site"], node: "24", python: null, setupSteps: 1, importCommands: 1,
    preflightCommands: 0, preflightChecks: null, acceptCommands: 0, adaptation: [], gates: ["zeroDiffPaths"], logProvenance: 0,
  },
  "lab-to-hub": {
    mode: "ai-adaptation", upstream: "lab-content", downstream: "example-org/hub", scopes: ["both", "content-only", "app-only"], commitOnly: "noop", installDirectories: [".", "apps/site"], node: "24", python: null, setupSteps: 1, importCommands: 0,
    preflightCommands: 2, preflightChecks: [["content-only", "classifier", null], ["app-only", "plain", null]], acceptCommands: 2, adaptation: ["preflightReports", "helpers", "pullRequestResult"],
    gates: ["zeroDiffPaths", "generatedPaths", "lockedTestBlocks", "inProcessInvariants"], logProvenance: 1,
  },
  "pipelines-to-hub": {
    mode: "ai-adaptation", upstream: "demo-pipelines", downstream: "example-org/hub", scopes: ["both", "runs-only"], commitOnly: "noop", installDirectories: [".", "apps/site"], node: null, python: null, setupSteps: 0, importCommands: 0,
    preflightCommands: 1, preflightChecks: [["runs-only", "classifier", "noop-unchanged-snapshot"]], acceptCommands: 1, adaptation: ["preflightReports"], gates: ["zeroDiffPaths", "lockedTestBlocks", "inProcessInvariants"], logProvenance: 0,
  },
  "course-to-hub": {
    mode: "ai-adaptation", upstream: "course-template", downstream: "example-org/hub", scopes: null, commitOnly: "bump-provenance", installDirectories: [".", "apps/site"], node: null, python: null, setupSteps: 0, importCommands: 0,
    preflightCommands: 1, preflightChecks: null, acceptCommands: 1, adaptation: [], gates: ["zeroDiffPaths", "lockedTestBlocks", "inProcessInvariants"], logProvenance: 0,
  },
  "orchestrator-to-hub": {
    mode: "mechanical", upstream: "orchestrator", downstream: "example-org/hub", scopes: null, commitOnly: "noop", installDirectories: [".", "apps/site"], node: null, python: null, setupSteps: 0, importCommands: 1,
    preflightCommands: 0, preflightChecks: null, acceptCommands: 0, adaptation: [], gates: ["zeroDiffPaths"], logProvenance: 0,
  },
  "config-to-registry": {
    mode: "mechanical", upstream: "config-kit", downstream: "example-org/asset-registry", scopes: null, commitOnly: "noop", installDirectories: null, node: null, python: "3.12", setupSteps: 0, importCommands: 1,
    preflightCommands: 0, preflightChecks: null, acceptCommands: 0, adaptation: [], gates: ["zeroDiffPaths"], logProvenance: 0,
  },
};

const featuresOf = (edge) => ({
  mode: edge.mode,
  upstream: edge.upstreamKey,
  downstream: edge.downstreamRepo,
  scopes: edge.syncScopes ?? null,
  commitOnly: edge.onCommitOnlyAdvance,
  installDirectories: edge.installDirectories ?? null,
  node: edge.nodeVersion ?? null,
  python: edge.pythonVersion ?? null,
  setupSteps: (edge.setupSteps ?? []).length,
  importCommands: (edge.importCommands ?? []).length,
  preflightCommands: (edge.preflightCommands ?? []).length,
  preflightChecks: edge.preflightChecks?.map((check) => [check.scope, check.classifier === undefined ? "plain" : "classifier", check.noopAction ?? null]) ?? null,
  acceptCommands: (edge.acceptCommands ?? []).length,
  adaptation: Object.keys(edge.adaptation ?? {}),
  gates: Object.keys(edge.immutableGates ?? {}),
  logProvenance: (edge.logProvenance ?? []).length,
});

test("six edges, in order, and the feature that each one keeps: which edge uses which feature", () => {
  assert.deepEqual(manifest.dependencyEdges.map((edge) => edge.edgeId), Object.keys(FEATURES));
  for (const [id, expected] of Object.entries(FEATURES)) assert.deepEqual(featuresOf(edgeOf(id)), expected, id);
});

test("the deeper features of the AI edges are there: the helper's manifest, the two result keys, the generated paths, a locked test block and the in-process invariants", () => {
  const lab = edgeOf("lab-to-hub");
  assert.deepEqual(lab.adaptation.helpers, { sourceCheck: { manifest: "apps/site/sources.json" } });
  assert.deepEqual(Object.keys(lab.adaptation.pullRequestResult), ["adaptedPages", "adaptedViews"]);
  assert.deepEqual(lab.adaptation.preflightReports, ["input-report.txt", "source-check.txt"]);
  assert.deepEqual(lab.immutableGates.generatedPaths, ["public/**"]);
  assert.ok(lab.immutableGates.lockedTestBlocks[0].blocks.length >= 1);
  assert.ok(Object.keys(lab.immutableGates.inProcessInvariants).length >= 1);
  assert.deepEqual(lab.logProvenance, [{ file: "apps/site/sources.json", pointer: "/_provenance/commit" }]);
  assert.match(lab.preflightChecks[0].classifier, /scripts\/classify-report\.mjs/);
  assert.match(edgeOf("pipelines-to-hub").preflightChecks[0].classifier, /scripts\/classify-runs\.mjs/);
  assert.match(edgeOf("course-to-hub").preflightCommands[0], /^git -C <checkout> diff --quiet /, "a plain git diff preflight");
});

test("the identity of every edge is derived the same way, and the graph is acyclic with the central repository's own edge as a self-cascade", () => {
  const edges = manifest.dependencyEdges;
  for (const edge of edges) {
    const upstream = projectOf(edge.upstreamKey);
    assert.equal(upstream.repo, edge.upstreamRepo, `${edge.edgeId}: upstreamKey names the project of upstreamRepo`);
    assert.equal(edge.stateVariable, `SDLC_SYNC_STATE_${edge.upstreamSlug}`, edge.edgeId);
    assert.equal(edge.upstreamSlug, edge.upstreamKey.toUpperCase().replaceAll("-", "_"), edge.edgeId);
    assert.equal(edge.branchName, `sdlc/cascade-${edge.edgeId}`);
    assert.equal(edge.closeOlderKey, `sdlc-cascade-${edge.edgeId}`);
    assert.match(edge.initialBaselineSha, /^[0-9a-f]{40}$/, edge.edgeId);
    assert.deepEqual(edge.reviewers, ["example-reviewer"], edge.edgeId);
    assert.equal(edge.autoMerge, false, edge.edgeId);
    assert.equal(edge.upstreamDefaultBranch, "main", edge.edgeId);
    assert.equal(edge.provenanceJsonPointer, "/commit", edge.edgeId);
    assert.ok(edge.allowedFiles.some((pattern) => globMatches(pattern, edge.provenanceFile)), `${edge.edgeId}: ${edge.provenanceFile} is one of the allowed files`);
  }
  for (const key of ["branchName", "closeOlderKey", "upstreamKey", "stateVariable"]) assert.equal(new Set(edges.map((edge) => edge[key])).size, edges.length, `${key} is distinct`);
  const upstreams = new Set(edges.map((edge) => edge.upstreamRepo));
  for (const edge of edges) assert.equal(upstreams.has(edge.downstreamRepo), false, `${edge.downstreamRepo} is never an upstream`);
  assert.equal(projectOf("orchestrator").repo, edgeOf("orchestrator-to-hub").upstreamRepo);
  assert.equal(projectOf("orchestrator").driftAudit.enabled, false, "the self-cascade has no drift audit of its own");
  assert.equal(edgeOf("config-to-registry").provenanceFile, "governance/upstream-provenance.json", "a different provenance file for the Python edge");
});

test("no schedule of the fleet starts at the top of the hour, where GitHub delays and drops runs", () => {
  const schedules = [
    ...manifest.dependencyEdges.map((edge) => [`edge ${edge.edgeId}`, edge.schedule]),
    ...manifest.projects.filter((project) => project.driftAudit.enabled).map((project) => [`drift ${project.projectKey}`, project.driftAudit.schedule]),
  ];
  assert.equal(schedules.length, 9, "six edges and three drift audits");
  for (const [owner, cron] of schedules) {
    assert.match(cron.split(" ")[0], /^\d+$/, `${owner}: '${cron}' names one minute`);
    assert.notEqual(Number(cron.split(" ")[0]), 0, `${owner}: '${cron}' starts on the hour`);
  }
});

test("the fleet is synthetic: every repository is under example-org, every reviewer is the example reviewer and every watched host is a reserved example name", () => {
  const repos = [...manifest.projects.map((project) => project.repo), ...manifest.dependencyEdges.flatMap((edge) => [edge.upstreamRepo, edge.downstreamRepo])];
  for (const repo of repos) assert.match(repo, /^example-org\/[a-z0-9-]+$/, repo);
  for (const project of manifest.projects.filter((candidate) => candidate.driftAudit.enabled)) {
    for (const host of hostsOf(project)) assert.match(host, /\.example\.(org|net)$/, `${project.projectKey}: ${host}`);
    assert.deepEqual([...new Set(project.driftAudit.reviewers)].filter((reviewer) => reviewer !== "example-reviewer"), [], project.projectKey);
  }
  assert.equal(JSON.parse(read("package.json")).name, "example-orchestrator");
});

test("the files around the manifest: the reference request is the s1 one, the compiler is pinned, and there is no prompts/ directory, so the package's own prompts are used", () => {
  const request = JSON.parse(read("request.reference.json"));
  assert.deepEqual(request, JSON.parse(fs.readFileSync(engineAbs("tests", "s1", "fixtures", "request.reference.json"), "utf8")), "the golden request and the one of the s1 tests are one request");
  assert.equal(request.appSlug, "example-orchestrator");
  assert.equal(request.engineAuthMode, "copilot-pat");
  assert.equal(request.manifestPath, "sdlc.yaml");
  assert.equal(read(".gh-aw-version"), "v1.0.1\n");
  assert.equal(fs.existsSync(engineAbs("examples", "prompts")), false);
  assert.deepEqual(fs.readdirSync(engineAbs("examples", "scripts")).sort(), ["check-sources.mjs", "classify-report.mjs", "classify-runs.mjs", "validate-example.mjs"]);
});
