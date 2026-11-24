// aiam repositories, first class: the inspection of an aiam instance (its governance/policy.yaml is the marker) and of the aiam toolkit
// itself (a pyproject.toml that declares the package), the synthesis of the projects[] and dependencyEdges[] entries for the cascade
// from the upstream of an instance to the instance, and the document that `aiam sdlc-preset` prints for the same repository.
//
// Every repository here is synthetic (example-owner/ai-assets, example-owner/aiam, example-owner/upstream-skills). The expected documents
// are the contract shared with `aiam sdlc-preset`: its own tests check the same objects, and the last test of this file runs both on one
// repository when AIAM_SRC names the src directory of an aiam checkout.
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import Ajv from "ajv";
import YAML from "yaml";
import { renderFleet } from "../../src/reconcile.mjs";
import { parseRemoteUrl } from "../../bin/lib/central-repo.mjs";
import { inspectRepository, localIdentity, localReader } from "../../bin/lib/inspect-repo.mjs";
import { resolveMode, resolveStrategy, synthesizeEdge, synthesizeProject } from "../../bin/lib/synthesize.mjs";
import { createWorkspace as createFleet, referenceRequest } from "../helpers/mini-fleet.mjs";
import { frontmatterOf } from "../helpers/rendered.mjs";
import { REPO_ROOT, createScenario, readFixture } from "./helpers/harness.mjs";

const INSTANCE = "example-owner/ai-assets";
const UPSTREAM = "example-owner/upstream-skills";
const COMMIT = "0123456789abcdef0123456789abcdef01234567";
const PROVENANCE = "governance/upstream-provenance.json";
const CODEOWNERS_FILE = ".github/CODEOWNERS";
const VERIFY = ["aiam validate", "aiam governance codeowners"];
const REVIEWERS = ["lead-dev", "platform-admin"];
const IDENTITY = { repo: INSTANCE, defaultBranch: "main", headSha: "b".repeat(40) };

// The three install steps, written out in full and independently of the code under test. The private one carries the plain shell
// variable ${GH_TOKEN}, never the Actions expression opener, which the manifest validator refuses in any string of a manifest.
const PRIVATE_INSTALL = [
  "GIT_TERMINAL_PROMPT=0 GIT_CONFIG_COUNT=3",
  'GIT_CONFIG_KEY_0="url.https://x-access-token:${GH_TOKEN}@github.com/example-owner/aiam.insteadOf"',
  'GIT_CONFIG_VALUE_0="ssh://git@github.com/example-owner/aiam"',
  'GIT_CONFIG_KEY_1="url.https://x-access-token:${GH_TOKEN}@github.com/example-owner/aiam.insteadOf"',
  'GIT_CONFIG_VALUE_1="git@github.com:example-owner/aiam"',
  'GIT_CONFIG_KEY_2="url.https://x-access-token:${GH_TOKEN}@github.com/example-owner/aiam.insteadOf"',
  'GIT_CONFIG_VALUE_2="https://github.com/example-owner/aiam"',
  'python -m pip install --quiet "aiam @ git+https://github.com/example-owner/aiam.git@v0.1.0"',
].join(" ");
const PUBLIC_INSTALL = 'python -m pip install --quiet "aiam @ git+https://github.com/example-owner/aiam.git@v0.1.0"';
const PYPI_INSTALL = 'python -m pip install --quiet "aiam==0.1.0"';
const GITHUB_ENGINE = { package: "aiam", source: "github:example-owner/aiam", ref: "v0.1.0" };
const ENGINES = {
  private: [{ ...GITHUB_ENGINE, private: true }, PRIVATE_INSTALL],
  public: [{ ...GITHUB_ENGINE, private: false }, PUBLIC_INSTALL],
  "public by default": [{ ...GITHUB_ENGINE }, PUBLIC_INSTALL],
  pypi: [{ package: "aiam", source: "pypi", ref: "0.1.0" }, PYPI_INSTALL],
};
const installStep = (run) => [{ name: "Install the aiam toolkit", run }];

// The engine blocks that `aiam reconcile` refuses and accepts. tests/test_sdlc_preset.py holds the same two tables.
const INVALID_ENGINES = {
  "not a mapping": "aiam",
  empty: {},
  null: null,
  "an unknown key": { ...GITHUB_ENGINE, extra: 1 },
  "no source": { package: "aiam", ref: "v0.1.0" },
  "no ref": { package: "aiam", source: "github:example-owner/aiam" },
  "a package with a space": { ...GITHUB_ENGINE, package: "ai am" },
  "a null package": { ...GITHUB_ENGINE, package: null },
  "a source with a .git suffix": { ...GITHUB_ENGINE, source: "github:example-owner/aiam.git" },
  "a source that is not github": { ...GITHUB_ENGINE, source: "gitlab:example-owner/aiam" },
  "an owner with shell syntax": { ...GITHUB_ENGINE, source: "github:example-owner$(id)/aiam" },
  "a repository named ..": { ...GITHUB_ENGINE, source: "github:example-owner/.." },
  "a ref that closes the quote": { ...GITHUB_ENGINE, ref: 'v1"; echo owned; "' },
  "a ref with a space": { ...GITHUB_ENGINE, ref: "v1 beta" },
  "a ref with two dots in a row": { ...GITHUB_ENGINE, ref: "v1..2" },
  "a ref with a leading dot": { ...GITHUB_ENGINE, ref: ".hidden" },
  "a ref with a double slash": { ...GITHUB_ENGINE, ref: "release//1" },
  "a numeric ref": { ...GITHUB_ENGINE, ref: 1.5 },
  "a private flag that is not a boolean": { ...GITHUB_ENGINE, private: "yes" },
  "a null private flag": { ...GITHUB_ENGINE, private: null },
  "a private pypi package": { package: "aiam", source: "pypi", ref: "0.1.0", private: true },
  "a pypi version with a space": { package: "aiam", source: "pypi", ref: "0.1 0" },
};
const VALID_ENGINES = {
  "private github": { ...GITHUB_ENGINE, private: true },
  "public github": { ...GITHUB_ENGINE, private: false },
  "package defaults to aiam": { source: "github:example-owner/aiam", ref: "v0.1.0" },
  "a commit sha": { ...GITHUB_ENGINE, ref: COMMIT },
  "a branch with a slash": { ...GITHUB_ENGINE, ref: "release/1.0" },
  pypi: { package: "aiam", source: "pypi", ref: "0.1.0" },
  "pypi with a local version": { package: "aiam", source: "pypi", ref: "0.1.0+local.1" },
  "another package name": { ...GITHUB_ENGINE, package: "aiam-toolkit" },
};

const CODEOWNERS = [
  "# Generated by `aiam governance codeowners --write` from governance/owners.yaml",
  "* @lead-dev @example-owner/platform-team",
  "/governance/ @platform-admin",
  "/.github/workflows/ @platform-admin @LEAD-DEV",
  "",
].join("\n");
const BASE_POLICY = { surfaces_by_kind: { skill: ["github-copilot-marketplace"] }, classification_rank: ["public", "general"] };
const OWNERS = { platform_owners: ["@platform-admin"], security_reviewers: ["platform-admin"], domains: {} };
const UPSTREAM_SYNC = {
  upstream_repository: UPSTREAM,
  provenance_file: PROVENANCE,
  default_owner: "@platform-admin",
  default_domain: "engineering",
  default_audience: "engineering",
  default_classification: "general",
  domain_routing: [],
  exclusions: [],
  surface_exclusions: {},
  path_rewrites: [],
  agent_companions: {},
  guardrails: { enabled: false },
};
const provenanceDocument = (changes = {}) => ({ format: "aiam-upstream/1", repository: UPSTREAM, commit: COMMIT, assets: {}, ...changes });

// The five generated workflows of an instance. Only the drift workflow has a schedule trigger.
const WORKFLOWS = {
  ".github/workflows/pr-checks.yml": "name: PR checks\non:\n  pull_request:\n    branches: [main]\n",
  ".github/workflows/security-gate.yml": "name: Security review gate\non:\n  pull_request:\n    types: [opened, synchronize]\n  pull_request_review:\n    types: [submitted, dismissed]\n",
  ".github/workflows/release.yml": "name: Release\non:\n  push:\n    branches: [main]\n",
  ".github/workflows/deploy.yml": "name: Deploy\non:\n  repository_dispatch:\n    types: [aiam-deploy]\n",
  ".github/workflows/drift.yml": 'name: Drift\non:\n  schedule:\n    - cron: "17 6 * * 1"\n  workflow_dispatch:\n',
};
const WORKFLOW_FACTS = [
  { path: ".github/workflows/deploy.yml", scheduled: false },
  { path: ".github/workflows/drift.yml", scheduled: true },
  { path: ".github/workflows/pr-checks.yml", scheduled: false },
  { path: ".github/workflows/release.yml", scheduled: false },
  { path: ".github/workflows/security-gate.yml", scheduled: false },
];

/** The files of a synthetic instance repository: `engine` is the policy's engine block, `sync` the upstream-sync.yaml (false: none), `provenance` its provenance file. */
function instanceFiles({ engine, sync = true, provenance = true, codeowners = CODEOWNERS, policy = {}, extra = {} } = {}) {
  const files = {
    "governance/policy.yaml": YAML.stringify({ ...BASE_POLICY, ...(engine === undefined ? {} : { engine }), ...policy }),
    "governance/owners.yaml": YAML.stringify(OWNERS),
    ...WORKFLOWS,
  };
  if (sync) {
    const config = { ...UPSTREAM_SYNC, ...(typeof sync === "object" ? sync : {}) };
    files["governance/upstream-sync.yaml"] = YAML.stringify(config);
    if (provenance === true) files[config.provenance_file] = `${JSON.stringify(provenanceDocument(), null, 2)}\n`;
    else if (typeof provenance === "object" && provenance !== null) files[config.provenance_file] = `${JSON.stringify(provenance, null, 2)}\n`;
    else if (typeof provenance === "string") files[config.provenance_file] = provenance;
  }
  if (codeowners !== null) files[CODEOWNERS_FILE] = codeowners;
  return { ...files, ...extra };
}

const readerOf = (files) => ({ list: () => Object.keys(files), read: async (file) => (Object.hasOwn(files, file) ? files[file] : null) });
const inspect = (files, identity = IDENTITY, options) => inspectRepository(readerOf(files), identity, options);

/** A reader that records what is read from it. */
function recording(files) {
  const reads = [];
  const reader = readerOf(files);
  return { reads, reader: { list: reader.list, read: async (file) => (reads.push(file), reader.read(file)) } };
}

/** The directory that holds `files`; it is removed when the test ends. */
function tree(t, files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sdlc-aiam-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  for (const [relative, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, ...relative.split("/"))), { recursive: true });
    fs.writeFileSync(path.join(dir, ...relative.split("/")), text);
  }
  return dir;
}

// --- the expected documents ------------------------------------------------------------------------------------------------

function projectOf(repo, { enabled, strategy, manifests = [], mcp = {}, build = [], verify = [], reviewers = [], branch = "main" }) {
  return {
    projectKey: repo.split("/")[1],
    repo,
    defaultBranch: branch,
    deconflictInRepoSchedules: "none",
    deconflictWorkflowIds: [],
    driftAudit: {
      enabled,
      schedule: "23 6 * * 1",
      upkeepStrategy: strategy,
      instructions: "",
      instructionsFile: null,
      knowledgeSources: { watchUrls: [], packageManifests: manifests, mcpServers: mcp },
      buildCommands: build,
      verifyCommands: verify,
      draft: false,
      reviewers,
    },
  };
}

function edgeOf({ setupSteps, reviewers = REVIEWERS, provenanceFile = PROVENANCE, codeowners = CODEOWNERS_FILE, upstreamBranch = "main", build = [] } = {}) {
  return {
    edgeId: "upstream-skills",
    upstreamRepo: UPSTREAM,
    upstreamKey: "upstream-skills",
    upstreamSlug: "UPSTREAM_SKILLS",
    upstreamDefaultBranch: upstreamBranch,
    initialBaselineSha: COMMIT,
    downstreamRepo: INSTANCE,
    mode: "mechanical",
    schedule: null,
    onCommitOnlyAdvance: "noop",
    stateVariable: "SDLC_SYNC_STATE_UPSTREAM_SKILLS",
    provenanceFile,
    provenanceJsonPointer: "/commit",
    branchName: "sdlc/cascade-upstream-skills",
    closeOlderKey: "sdlc-cascade-upstream-skills",
    reviewers,
    pythonVersion: "3.12",
    ...(setupSteps ? { setupSteps } : {}),
    importCommands: ["aiam sync-upstream --from <checkout>"],
    preflightCommands: [],
    acceptCommands: [],
    buildCommands: build,
    verifyCommands: VERIFY,
    adaptationInstructions: "",
    allowedFiles: ["assets/**", "governance/cowork-preferences-source.md", codeowners, provenanceFile],
    protectedFilesExclude: [],
    autoMerge: false,
    immutableGates: { zeroDiffPaths: [] },
  };
}

const cascadeOf = (edgeChanges) => ({
  projects: [
    projectOf(UPSTREAM, { enabled: true, strategy: "code-quality-and-improvement-scan" }),
    projectOf(INSTANCE, { enabled: false, strategy: "content-and-docs-sync", verify: VERIFY, reviewers: REVIEWERS }),
  ],
  dependencyEdges: [edgeOf(edgeChanges)],
});

const EDGE_KEY_ORDER = [
  "edgeId", "upstreamRepo", "upstreamKey", "upstreamSlug", "upstreamDefaultBranch", "initialBaselineSha", "downstreamRepo", "mode", "schedule",
  "onCommitOnlyAdvance", "stateVariable", "provenanceFile", "provenanceJsonPointer", "branchName", "closeOlderKey", "reviewers", "pythonVersion",
  "setupSteps", "importCommands", "preflightCommands", "acceptCommands", "buildCommands", "verifyCommands", "adaptationInstructions", "allowedFiles",
  "protectedFilesExclude", "autoMerge", "immutableGates",
];

/** What `sdlc-onboard --repo <upstream> --downstream <instance>` synthesizes for an instance, with nothing known of the upstream, as `aiam sdlc-preset` prints it. */
async function presetOf(downstream, { upstreamBranch = "main" } = {}) {
  const strategyOf = (inspection) => resolveStrategy("auto", { watchUrls: [], inspection });
  if (typeof downstream.aiam?.upstreamRepo !== "string") return { projects: [synthesizeProject({ inspection: downstream, strategy: strategyOf(downstream) })], dependencyEdges: [] };
  const upstream = await inspectRepository(readerOf({}), { repo: downstream.aiam.upstreamRepo, defaultBranch: upstreamBranch, headSha: null });
  const { edge, missing } = synthesizeEdge({ upstream, downstream, mode: "auto" });
  assert.deepEqual(missing, []);
  return {
    projects: [synthesizeProject({ inspection: upstream, strategy: strategyOf(upstream) }), synthesizeProject({ inspection: downstream, strategy: strategyOf(downstream), enabled: false })],
    dependencyEdges: [edge],
  };
}

const validate = new Ajv({ allErrors: true, strict: true }).compile(JSON.parse(fs.readFileSync(path.join(REPO_ROOT, "schemas", "sdlc.schema.json"), "utf8")));
const assertSchemaValid = (preset, label = "") => assert.ok(validate(preset), `${label}${JSON.stringify(validate.errors)}`);
const stringsOf = (value) => (typeof value === "string" ? [value] : value !== null && typeof value === "object" ? Object.values(value).flatMap(stringsOf) : []);

// --- the inspection of an aiam instance ------------------------------------------------------------------------------------

test("aiam instance: governance/policy.yaml marks it, its commands are aiam's, and the repository has no package.json warning", async () => {
  const [engine, run] = ENGINES.private;
  const inspection = await inspect(instanceFiles({ engine }));
  assert.deepEqual(inspection, {
    repo: INSTANCE,
    defaultBranch: "main",
    headSha: "b".repeat(40),
    packageManifests: [],
    scriptNames: [],
    buildCommands: [],
    verifyCommands: VERIFY,
    importScripts: [],
    workflows: WORKFLOW_FACTS,
    provenanceFiles: [{ path: PROVENANCE, commit: COMMIT, pointer: "/commit" }],
    codeowners: { present: true, individuals: REVIEWERS, teams: ["@example-owner/platform-team"] },
    warnings: [],
    aiam: {
      kind: "instance",
      upstreamRepo: UPSTREAM,
      provenanceFile: PROVENANCE,
      importCommands: ["aiam sync-upstream --from <checkout>"],
      allowedFiles: ["assets/**", "governance/cowork-preferences-source.md", CODEOWNERS_FILE, PROVENANCE],
      pythonVersion: "3.12",
      setupSteps: installStep(run),
    },
  });
});

for (const [label, [engine, run]] of Object.entries(ENGINES)) {
  test(`aiam instance: the setup step of a ${label} engine is the install of the toolkit, and it holds no Actions expression`, async () => {
    const inspection = await inspect(instanceFiles({ engine }));
    assert.deepEqual(inspection.aiam.setupSteps, installStep(run));
    assert.deepEqual(inspection.warnings, []);
    assert.equal(run.includes("${{"), false);
  });
}

test("aiam instance: without an engine block the edge has no setup step and the inspection has no warning", async () => {
  const inspection = await inspect(instanceFiles());
  assert.deepEqual(inspection.aiam.setupSteps, []);
  assert.deepEqual(inspection.warnings, []);
  const preset = await presetOf(inspection);
  assert.equal("setupSteps" in preset.dependencyEdges[0], false);
  assert.deepEqual(preset, cascadeOf());
});

test("aiam instance: without governance/upstream-sync.yaml it is an instance and nothing more: no cascade facts, no provenance file", async () => {
  const inspection = await inspect(instanceFiles({ engine: ENGINES.private[0], sync: false }));
  assert.deepEqual(inspection.aiam, { kind: "instance" });
  assert.deepEqual(inspection.provenanceFiles, []);
  assert.deepEqual(inspection.verifyCommands, VERIFY);
  assert.deepEqual(inspection.warnings, []);
});

test("aiam instance: a pyproject.toml beside the policy neither makes it the toolkit nor is read", async () => {
  const { reader, reads } = recording(instanceFiles({ sync: false, extra: { "pyproject.toml": '[project]\nname = "aiam"\n' } }));
  const inspection = await inspectRepository(reader, IDENTITY);
  assert.deepEqual(inspection.aiam, { kind: "instance" });
  assert.deepEqual(inspection.verifyCommands, VERIFY);
  assert.equal(reads.includes("pyproject.toml"), false);
  assert.deepEqual(inspection.packageManifests, ["pyproject.toml"]);
});

test("aiam instance: a root package.json still supplies the build command, and the instance's own commands replace npm test", async () => {
  const inspection = await inspect(instanceFiles({ sync: false, extra: { "package.json": JSON.stringify({ scripts: { build: "tsc", test: "node --test" } }) } }));
  assert.deepEqual(inspection.buildCommands, ["npm run build"]);
  assert.deepEqual(inspection.verifyCommands, VERIFY);
  assert.deepEqual(inspection.warnings, []);
});

test("aiam instance: the CODEOWNERS file is the one that codeowners_path names, for the reviewers and for allowedFiles", async () => {
  const files = instanceFiles({ policy: { codeowners_path: "/docs/CODEOWNERS " }, codeowners: null, extra: { "docs/CODEOWNERS": "* @docs-owner\n", [CODEOWNERS_FILE]: "* @ignored-owner\n" } });
  const inspection = await inspect(files);
  assert.deepEqual(inspection.codeowners, { present: true, individuals: ["docs-owner"], teams: [] });
  assert.deepEqual(inspection.aiam.allowedFiles, ["assets/**", "governance/cowork-preferences-source.md", "docs/CODEOWNERS", PROVENANCE]);
  for (const policy of [{ codeowners_path: "" }, { codeowners_path: "/" }, { codeowners_path: 7 }, {}]) {
    const plain = await inspect(instanceFiles({ policy }));
    assert.equal(plain.aiam.allowedFiles[2], CODEOWNERS_FILE, JSON.stringify(policy));
    assert.deepEqual(plain.codeowners.individuals, REVIEWERS);
  }
});

test("aiam instance: a repository that is not an aiam instance keeps reading CODEOWNERS only at .github/CODEOWNERS", async () => {
  const inspection = await inspect({ "package.json": '{ "scripts": { "test": "node --test" } }', "docs/CODEOWNERS": "* @someone\n", "governance/readme.md": "x" });
  assert.deepEqual(inspection.codeowners, { present: false, individuals: [], teams: [] });
  assert.equal("aiam" in inspection, false);
});

test("aiam instance: the provenance file is read once and listed once, whatever its name, and the list stays sorted by path", async () => {
  const named = await inspect(instanceFiles({ sync: { provenance_file: "governance/provenance.json" } }));
  assert.deepEqual(named.provenanceFiles, [{ path: "governance/provenance.json", commit: COMMIT, pointer: "/commit" }]);
  const noise = { commit: "1111111111111111111111111111111111111111" };
  const both = await inspect(instanceFiles({ extra: { "assets/skills/x/provenance.json": JSON.stringify(noise), "zz/source.json": JSON.stringify(noise) } }));
  assert.deepEqual(both.provenanceFiles.map((file) => file.path), ["assets/skills/x/provenance.json", PROVENANCE, "zz/source.json"]);
  const { edge, missing } = synthesizeEdge({ upstream: await inspect({}, { repo: UPSTREAM, defaultBranch: "main", headSha: null }), downstream: both });
  assert.equal(edge, null);
  assert.match(missing[0], /3 provenance files found in example-owner\/ai-assets; exactly one is needed/);
});

test("aiam instance: it reads the files it needs and no others, and writes nothing", async (t) => {
  const files = instanceFiles({ engine: ENGINES.private[0], extra: { "assets/skills/x/SKILL.md": "x", "README.md": "x" } });
  const { reader, reads } = recording(files);
  await inspectRepository(reader, IDENTITY);
  assert.deepEqual(
    [...new Set(reads)].sort(),
    [CODEOWNERS_FILE, ...Object.keys(WORKFLOWS), "governance/policy.yaml", PROVENANCE, "governance/upstream-sync.yaml"].sort(),
  );
  const dir = tree(t, files);
  const hashes = () => Object.fromEntries(Object.keys(files).map((file) => [file, crypto.createHash("sha256").update(fs.readFileSync(path.join(dir, ...file.split("/")))).digest("hex")]));
  const before = hashes();
  await inspectRepository(localReader(dir), IDENTITY);
  assert.deepEqual(hashes(), before);
  assert.deepEqual(fs.readdirSync(dir).sort(), ["assets", "governance", ".github", "README.md"].sort());
});

test("aiam instance: a checkout on disk gives the inspection of the same files in memory", async (t) => {
  const files = instanceFiles({ engine: ENGINES.public[0], extra: { "node_modules/dep/package.json": "{}", ".git/config": "x", "tools/go.mod": "module example.com/tools\n" } });
  const onDisk = await inspectRepository(localReader(tree(t, files)), IDENTITY);
  const inMemory = await inspect(Object.fromEntries(Object.entries(files).filter(([file]) => !file.startsWith("node_modules/") && !file.startsWith(".git/"))));
  assert.deepEqual(onDisk, inMemory);
  assert.deepEqual(onDisk.packageManifests, ["tools/go.mod"]);
});

// --- the inspection of the aiam toolkit ------------------------------------------------------------------------------------

test("aiam toolkit: a pyproject.toml that declares the package aiam, with no governance/policy.yaml, is the toolkit with its own test command", async () => {
  for (const toml of ['[project]\nname = "aiam"\nversion = "0.1.0"\n', "[project]\nname = 'aiam'\n", '[project]\nname="aiam"  # the toolkit\n', '[build-system]\nrequires = []\n\n[project]\n  name   =   "aiam"\n']) {
    const inspection = await inspect({ "pyproject.toml": toml, "src/aiam/__init__.py": "" });
    assert.deepEqual(inspection.verifyCommands, ["python -m pytest -q"], toml);
    assert.deepEqual(inspection.warnings, [], toml);
    assert.deepEqual(inspection.aiam, { kind: "engine" }, toml);
    assert.deepEqual(inspection.packageManifests, ["pyproject.toml"]);
  }
});

test("aiam toolkit: another package, a longer name, a comment or a pyproject below the root is not the toolkit, and the empty-command warning stays", async () => {
  for (const files of [
    { "pyproject.toml": '[project]\nname = "other"\n' },
    { "pyproject.toml": '[project]\nname = "aiam-extras"\n' },
    { "pyproject.toml": '[project]\nname = "aiamx"\n' },
    { "pyproject.toml": '[project]\n# name = "aiam"\nname = "other"\n' },
    { "tools/pyproject.toml": '[project]\nname = "aiam"\n' },
  ]) {
    const inspection = await inspect(files);
    assert.deepEqual(inspection.verifyCommands, [], JSON.stringify(files));
    assert.equal("aiam" in inspection, false, JSON.stringify(files));
    assert.equal(inspection.warnings.length, 1, JSON.stringify(files));
    assert.match(inspection.warnings[0], /no package\.json at its root, so verifyCommands is empty/);
  }
});

test("aiam toolkit: a pyproject.toml over the size the inspection reads, or one that cannot be read, is not the toolkit", async () => {
  const unreadable = { list: () => ["pyproject.toml"], read: async () => null };
  const inspection = await inspectRepository(unreadable, IDENTITY);
  assert.equal("aiam" in inspection, false);
  assert.deepEqual(inspection.verifyCommands, []);
});

test("aiam toolkit: a repository without any aiam file is inspected exactly as before", async () => {
  const inspection = await inspect({ "package.json": '{ "scripts": { "test": "node --test", "build": "tsc" } }', "README.md": "x" });
  assert.equal("aiam" in inspection, false);
  assert.deepEqual(inspection.verifyCommands, ["npm test"]);
  assert.deepEqual(inspection.buildCommands, ["npm run build"]);
  assert.deepEqual(inspection.warnings, []);
});

// --- invalid aiam files are warnings, never an exception ---------------------------------------------------------------------

test("aiam instance: a policy that is not valid YAML, not a mapping, or unreadable is a warning and the instance is still one", async () => {
  for (const [text, warning] of [
    ["engine: [unclosed\n", /governance\/policy\.yaml is not valid YAML/],
    ["- just\n- a list\n", /governance\/policy\.yaml is not a YAML mapping/],
    ["", /governance\/policy\.yaml is not a YAML mapping/],
    [null, /governance\/policy\.yaml could not be read/],
  ]) {
    const files = { ...instanceFiles({ sync: false }), "governance/policy.yaml": text };
    const inspection = await inspectRepository({ list: () => Object.keys(files), read: async (file) => (file === "governance/policy.yaml" ? text : files[file] ?? null) }, IDENTITY);
    assert.deepEqual(inspection.verifyCommands, VERIFY, String(text));
    assert.deepEqual(inspection.aiam, { kind: "instance" }, String(text));
    assert.equal(inspection.warnings.length, 1, String(text));
    assert.match(inspection.warnings[0], warning);
  }
});

for (const [label, engine] of Object.entries(INVALID_ENGINES)) {
  test(`aiam instance: an engine block with ${label} is a warning, and the edge is still synthesized, without a setup step`, async () => {
    const inspection = await inspect(instanceFiles({ engine }));
    assert.equal(inspection.warnings.length, 1);
    assert.match(inspection.warnings[0], /^governance\/policy\.yaml: engine/);
    assert.deepEqual(inspection.aiam.setupSteps, []);
    assert.deepEqual(inspection.verifyCommands, VERIFY);
    const preset = await presetOf(inspection);
    assert.deepEqual(preset, cascadeOf());
  });
}

test("aiam instance: no warning echoes a value of the repository, so that no credential-shaped text can travel through one", async () => {
  const inspection = await inspect(instanceFiles({ engine: { ...GITHUB_ENGINE, ref: 'v1"; echo owned; "', extra: "marker-value" } }));
  for (const warning of inspection.warnings) assert.doesNotMatch(warning, /owned|marker-value|v1/);
});

test("aiam instance: engine blocks that `aiam reconcile` accepts give one install step, and nothing else is warned", async () => {
  for (const [label, engine] of Object.entries(VALID_ENGINES)) {
    const inspection = await inspect(instanceFiles({ engine }));
    assert.deepEqual(inspection.warnings, [], label);
    assert.equal(inspection.aiam.setupSteps.length, 1, label);
    assert.equal(inspection.aiam.setupSteps[0].name, "Install the aiam toolkit");
    assert.equal(inspection.aiam.setupSteps[0].run.includes("${{"), false, label);
  }
});

test("aiam instance: an upstream-sync.yaml that is not valid, not a mapping, or unreadable is a warning and leaves a bare instance", async () => {
  for (const [text, warning] of [
    ["upstream_repository: [unclosed\n", /governance\/upstream-sync\.yaml is not valid YAML/],
    ["- just\n- a list\n", /governance\/upstream-sync\.yaml is not a YAML mapping/],
    [null, /governance\/upstream-sync\.yaml could not be read/],
  ]) {
    const files = instanceFiles({ sync: false });
    files["governance/upstream-sync.yaml"] = text ?? "";
    const inspection = await inspectRepository({ list: () => Object.keys(files), read: async (file) => (file === "governance/upstream-sync.yaml" ? text : files[file] ?? null) }, IDENTITY);
    assert.deepEqual(inspection.aiam, { kind: "instance" }, String(text));
    assert.equal(inspection.warnings.length, 1, String(text));
    assert.match(inspection.warnings[0], warning);
  }
});

test("aiam instance: an upstream_repository that is not valid is a warning, and nothing else changes: the upstream of an edge is the one that onboarding is given", async () => {
  const upstream = await inspect({}, { repo: UPSTREAM, defaultBranch: "main", headSha: null });
  for (const upstream_repository of [7, "not a slug", null]) {
    const inspection = await inspect(instanceFiles({ sync: { upstream_repository } }));
    assert.equal(inspection.warnings.length, 1, String(upstream_repository));
    assert.match(inspection.warnings[0], /^governance\/upstream-sync\.yaml has no valid upstream_repository/);
    assert.equal(inspection.aiam.upstreamRepo, null);
    assert.deepEqual(inspection.provenanceFiles, [{ path: PROVENANCE, commit: COMMIT, pointer: "/commit" }]);
    assert.deepEqual(synthesizeEdge({ upstream, downstream: inspection }).missing, []);
  }
});

test("aiam instance: a provenance_file that is not valid is a warning, the glob list has the three fixed entries, and the edge cannot be synthesized", async () => {
  const upstream = await inspect({}, { repo: UPSTREAM, defaultBranch: "main", headSha: null });
  for (const provenance_file of [7, "../outside.json", "/etc/provenance.json", "C:\\provenance.json", "governance\\provenance.json", ""]) {
    const inspection = await inspect(instanceFiles({ sync: { provenance_file }, provenance: false }));
    assert.equal(inspection.warnings.length, 1, JSON.stringify(provenance_file));
    assert.match(inspection.warnings[0], /^governance\/upstream-sync\.yaml has no valid provenance_file/);
    assert.equal(inspection.aiam.provenanceFile, null);
    assert.deepEqual(inspection.aiam.allowedFiles, ["assets/**", "governance/cowork-preferences-source.md", CODEOWNERS_FILE]);
    assert.deepEqual(inspection.provenanceFiles, []);
    const { edge, missing } = synthesizeEdge({ upstream, downstream: inspection });
    assert.equal(edge, null);
    assert.match(missing[0], /no provenance file found in example-owner\/ai-assets/);
  }
});

test("aiam instance: a provenance file that the repository does not hold is a warning that says what to run", async () => {
  const inspection = await inspect(instanceFiles({ provenance: false }));
  assert.equal(inspection.warnings.length, 1);
  assert.match(inspection.warnings[0], /names the provenance file governance\/upstream-provenance\.json, which the repository does not contain; run aiam sync-upstream once/);
  assert.deepEqual(inspection.provenanceFiles, []);
});

test("aiam instance: a provenance file that is not valid JSON, or holds no 40-hex commit, is listed without a commit, and its edge names the missing pointer", async () => {
  const upstream = await inspect({}, { repo: UPSTREAM, defaultBranch: "main", headSha: null });
  for (const [provenance, warnings] of [
    ["{ not json", [`${PROVENANCE} is not valid JSON`]],
    [provenanceDocument({ commit: "0123456" }), []],
    [{ format: "aiam-upstream/1", repository: UPSTREAM, assets: {} }, []],
  ]) {
    const inspection = await inspect(instanceFiles({ provenance }));
    assert.deepEqual(inspection.warnings, warnings);
    assert.deepEqual(inspection.provenanceFiles, [{ path: PROVENANCE, commit: null, pointer: null }]);
    const { edge, missing } = synthesizeEdge({ upstream, downstream: inspection });
    assert.equal(edge, null);
    assert.match(missing[0], /provenanceJsonPointer \(governance\/upstream-provenance\.json holds no 40-hex "commit" key\)/);
  }
});

test("aiam instance: a provenance file of another format or another repository is a warning, and its commit is still listed", async () => {
  for (const [provenance, warning] of [
    [provenanceDocument({ format: "aiam-upstream/2" }), `${PROVENANCE} is not an aiam upstream provenance file (format "aiam-upstream/1")`],
    [provenanceDocument({ repository: "example-owner/another-upstream" }), `${PROVENANCE} records another repository than the upstream_repository of governance/upstream-sync.yaml`],
    [[], `${PROVENANCE} is not an aiam upstream provenance file (format "aiam-upstream/1")`],
  ]) {
    const inspection = await inspect(instanceFiles({ provenance }));
    assert.deepEqual(inspection.warnings, [warning]);
    assert.equal(inspection.provenanceFiles.length, 1);
  }
});

// --- the synthesis -----------------------------------------------------------------------------------------------------------

for (const [label, [engine, run]] of Object.entries(ENGINES)) {
  test(`aiam preset: a ${label} engine gives two projects and a mechanical edge, with no missing field, no note and no warning`, async () => {
    const downstream = await inspect(instanceFiles({ engine }));
    const upstream = await inspect({}, { repo: UPSTREAM, defaultBranch: "main", headSha: null });
    const synthesized = synthesizeEdge({ upstream, downstream, mode: "auto" });
    assert.deepEqual(synthesized.missing, []);
    assert.deepEqual(synthesized.notes, []);
    assert.equal(synthesized.baselineSource, "the commit recorded by the downstream provenance file governance/upstream-provenance.json");
    assert.deepEqual(downstream.warnings, []);
    const preset = await presetOf(downstream);
    assert.deepEqual(preset, cascadeOf({ setupSteps: installStep(run) }));
    assert.deepEqual(synthesized.edge, preset.dependencyEdges[0]);
  });
}

test("aiam preset: the document validates against sdlc.schema.json in every shape, and no string of it holds the expression opener", async () => {
  const presets = [await presetOf(await inspect(instanceFiles({ sync: false })))];
  for (const [label, [engine]] of Object.entries(ENGINES)) presets.push(await presetOf(await inspect(instanceFiles({ engine }))));
  presets.push(await presetOf(await inspect(instanceFiles({ extra: { "package.json": JSON.stringify({ scripts: { build: "tsc" } }), "pyproject.toml": "[project]\nname = 'x'\n" } }))));
  presets.push(await presetOf(await inspect(instanceFiles({ sync: false, extra: { "pyproject.toml": "[project]\nname = 'x'\n" } }))));
  for (const preset of presets) {
    assertSchemaValid(preset);
    assert.equal(stringsOf(preset).some((text) => text.includes("${{")), false);
  }
  assert.equal(presets.length, 7);
});

test("aiam preset: an instance without an upstream is one enabled project with the strategy that its files give, and no edge", async () => {
  const plain = await presetOf(await inspect(instanceFiles({ sync: false })));
  assert.deepEqual(plain, { projects: [projectOf(INSTANCE, { enabled: true, strategy: "code-quality-and-improvement-scan", verify: VERIFY, reviewers: REVIEWERS })], dependencyEdges: [] });
  const python = await presetOf(await inspect(instanceFiles({ sync: false, extra: { "pyproject.toml": "[project]\nname = 'ai-assets'\n" } })));
  assert.deepEqual(python.projects[0].driftAudit.knowledgeSources, {
    watchUrls: [],
    packageManifests: ["pyproject.toml"],
    mcpServers: { context7: { command: "npx", args: ["-y", "@upstash/context7-mcp@latest"] } },
  });
  assert.equal(python.projects[0].driftAudit.upkeepStrategy, "dependency-and-pattern-modernization");
});

test("aiam preset: the edge has the schema's fields in the order of the factory's own examples, with pythonVersion and setupSteps after the reviewers", async () => {
  const [engine] = ENGINES.private;
  const { dependencyEdges } = await presetOf(await inspect(instanceFiles({ engine })));
  assert.deepEqual(Object.keys(dependencyEdges[0]), EDGE_KEY_ORDER);
  const withoutEngine = await presetOf(await inspect(instanceFiles()));
  assert.deepEqual(Object.keys(withoutEngine.dependencyEdges[0]), EDGE_KEY_ORDER.filter((key) => key !== "setupSteps"));
});

test("aiam preset: the edge's allowedFiles are the instance's own, and the generic edge keeps the directory of its provenance file", async () => {
  const { dependencyEdges } = await presetOf(await inspect(instanceFiles({ sync: { provenance_file: "governance/sync/provenance.json" } })));
  assert.deepEqual(dependencyEdges[0].allowedFiles, ["assets/**", "governance/cowork-preferences-source.md", CODEOWNERS_FILE, "governance/sync/provenance.json"]);
  const generic = synthesizeEdge({
    upstream: await inspect({}, { repo: UPSTREAM, defaultBranch: "main", headSha: null }),
    downstream: await inspect({ "data/source.json": JSON.stringify({ commit: COMMIT }), ".github/CODEOWNERS": "* @lead-dev\n" }, IDENTITY),
  });
  assert.deepEqual(generic.edge.allowedFiles, ["data/**"]);
  assert.deepEqual(generic.edge.importCommands, []);
  assert.equal("pythonVersion" in generic.edge, false);
  assert.equal("setupSteps" in generic.edge, false);
  assert.deepEqual(generic.notes, [], "a generic downstream with no import script resolves to ai-adaptation, which has no note");
});

test("aiam preset: --mode mechanical on a downstream with no import command still notes the empty importCommands, and an aiam one does not", async () => {
  const upstream = await inspect({}, { repo: UPSTREAM, defaultBranch: "main", headSha: null });
  const generic = await inspect({ "data/source.json": JSON.stringify({ commit: COMMIT }), ".github/CODEOWNERS": "* @lead-dev\n" });
  const forced = synthesizeEdge({ upstream, downstream: generic, mode: "mechanical" });
  assert.deepEqual(forced.notes, ["importCommands is empty: add the command that imports the upstream into the downstream to sdlc.yaml"]);
  const aiam = synthesizeEdge({ upstream, downstream: await inspect(instanceFiles()), mode: "mechanical" });
  assert.deepEqual(aiam.notes, []);
  const adaptive = synthesizeEdge({ upstream, downstream: await inspect(instanceFiles()), mode: "ai-adaptation" });
  assert.equal(adaptive.edge.mode, "ai-adaptation");
  assert.deepEqual(adaptive.edge.importCommands, ["aiam sync-upstream --from <checkout>"], "the import command is the instance's whatever the mode");
});

test("aiam preset: --mode auto is mechanical for a downstream with exactly one import script or with an aiam import command, else ai-adaptation", () => {
  assert.equal(resolveMode("auto", { importScripts: ["import:a"] }), "mechanical");
  assert.equal(resolveMode("auto", { importScripts: [] }), "ai-adaptation");
  assert.equal(resolveMode("auto", { importScripts: ["import:a", "import:b"] }), "ai-adaptation");
  assert.equal(resolveMode("auto", { importScripts: [], aiam: { kind: "instance", importCommands: ["aiam sync-upstream --from <checkout>"] } }), "mechanical");
  assert.equal(resolveMode("auto", { importScripts: ["import:a", "import:b"], aiam: { kind: "instance", importCommands: ["x"] } }), "mechanical");
  assert.equal(resolveMode("auto", { importScripts: [], aiam: { kind: "instance" } }), "ai-adaptation");
  assert.equal(resolveMode("auto", { importScripts: [], aiam: { kind: "instance", importCommands: [] } }), "ai-adaptation");
  assert.equal(resolveMode("auto", { importScripts: [], aiam: { kind: "engine" } }), "ai-adaptation");
  assert.equal(resolveMode("ai-adaptation", { importScripts: [], aiam: { kind: "instance", importCommands: ["x"] } }), "ai-adaptation");
  assert.equal(resolveMode("mechanical", { importScripts: [] }), "mechanical");
});

test("aiam preset: a library whose configured provenance file is missing is not onboarded through a stray file of a conventional name", async () => {
  const upstream = await inspect({}, { repo: UPSTREAM, defaultBranch: "main", headSha: null });
  const downstream = await inspect(instanceFiles({ provenance: false, extra: { "vendor/source.json": JSON.stringify({ commit: COMMIT }) } }));
  assert.deepEqual(downstream.provenanceFiles.map((file) => file.path), ["vendor/source.json"]);
  const { edge, missing } = synthesizeEdge({ upstream, downstream });
  assert.equal(edge, null, "an edge that tracks vendor/source.json would disagree with the allowedFiles that the library's own configuration gives");
  assert.equal(missing.length, 1);
  assert.match(missing[0], /^provenanceFile \(governance\/upstream-provenance\.json, the provenance_file of governance\/upstream-sync\.yaml, is not in example-owner\/ai-assets/);
  const generic = await inspect({ "vendor/source.json": JSON.stringify({ commit: COMMIT }), ".github/CODEOWNERS": "* @lead-dev\n" });
  assert.deepEqual(synthesizeEdge({ upstream, downstream: generic }).missing, [], "a downstream that is not an aiam library keeps the provenance file that the name scan finds");
});

test("aiam preset: an instance whose team owners are all teams cannot be a downstream: the reviewers are missing, and nothing is invented", async () => {
  const upstream = await inspect({}, { repo: UPSTREAM, defaultBranch: "main", headSha: null });
  const downstream = await inspect(instanceFiles({ codeowners: "* @example-owner/platform-team\n" }));
  const { edge, missing } = synthesizeEdge({ upstream, downstream });
  assert.equal(edge, null);
  assert.equal(missing.length, 1);
  assert.match(missing[0], /^reviewers \(no individual owner in \.github\/CODEOWNERS of example-owner\/ai-assets/);
});

test("aiam preset: the repository names project keys and slugs in the factory's way", async () => {
  const preset = await presetOf(await inspect(instanceFiles(), { repo: "Example-Owner/Docs_Library.Hub", defaultBranch: "trunk", headSha: null }));
  assert.equal(preset.projects[1].projectKey, "docs-library-hub");
  assert.equal(preset.projects[1].defaultBranch, "trunk");
  assert.equal(preset.dependencyEdges[0].downstreamRepo, "Example-Owner/Docs_Library.Hub");
});

test("aiam preset: remote URLs name repositories as `aiam sdlc-preset` reads them (the same table as tests/test_sdlc_preset.py)", () => {
  for (const [url, slug] of [
    ["https://github.com/example-owner/ai-assets.git", INSTANCE],
    ["https://github.com/example-owner/ai-assets", INSTANCE],
    ["https://github.com/example-owner/ai-assets/", INSTANCE],
    ["git@github.com:example-owner/ai-assets.git", INSTANCE],
    ["ssh://git@github.com/example-owner/ai-assets.git", INSTANCE],
    ["https://x-access-token:token@github.com/example-owner/ai-assets.git", INSTANCE],
    ["https://github.example.org/a/b/example-owner/ai-assets.git", INSTANCE],
    ["file:///srv/git/ai-assets.git", null],
    ["/srv/git/ai-assets.git", null],
    ["ai-assets", null],
    ["https://github.com/ai-assets.git", null],
    ["git@github.com:ai-assets.git", null],
    ["https://github.com/example-owner/..", null],
    ["", null],
  ]) {
    assert.equal(parseRemoteUrl(url), slug, url);
  }
});

// --- the real renderer and the real onboarding command -----------------------------------------------------------------------

test("aiam cascade: the renderer accepts the edge, sets up Python and the toolkit before the agent starts, and runs the instance's import command", async (t) => {
  const [engine, run] = ENGINES.private;
  const preset = await presetOf(await inspect(instanceFiles({ engine })));
  // A drift project that is enabled needs instructions and a verify command, which a preset leaves to the operator; the edge is what is under test.
  for (const entry of preset.projects) entry.driftAudit.enabled = false;
  const work = createFleet(t, { manifest: preset });
  const result = renderFleet(referenceRequest(), { cwd: work.dir });
  assert.equal(result.ok, true, JSON.stringify(result.result));
  const file = result.files.get(".github/workflows/cascade-mechanical-upstream-skills.md");
  assert.ok(file, [...result.files.keys()].join("\n"));
  const { steps } = frontmatterOf(file);
  const names = steps.map((step) => step.name);
  assert.deepEqual(names.slice(0, 3), ["Set up Python 3.12", "Install dependencies (root)", "Install the aiam toolkit"]);
  const install = steps.find((step) => step.name === "Install the aiam toolkit");
  assert.equal(install.run, run);
  assert.equal(install["working-directory"], steps[1]["working-directory"]);
  assert.match(file, /aiam sync-upstream --from/);
});

test("aiam cascade: sdlc-onboard --repo <upstream> --downstream <instance> writes the edge, with no empty-importCommands note and no package.json warning", async () => {
  const [engine, run] = ENGINES.private;
  const repo = (id, files) => ({ id, defaultBranch: "main", headSha: "a".repeat(40), files });
  const scenario = await createScenario({
    fake: { repos: { [UPSTREAM]: repo(9001, { "README.md": "# upstream\n" }), [INSTANCE]: repo(9002, instanceFiles({ engine })) } },
    workspace: { manifest: readFixture("manifest.empty.yaml") },
  });
  try {
    const result = await scenario.onboard(["--repo", UPSTREAM, "--downstream", INSTANCE], { env: scenario.env(scenario.appCredentials()) });
    assert.equal(result.code, 0, result.stderr);
    assert.doesNotMatch(result.stderr, /importCommands is empty/);
    assert.doesNotMatch(result.stderr, new RegExp(`${INSTANCE}: .*package\\.json`));
    assert.match(result.stderr, /Edge upstream-skills: example-owner\/upstream-skills -> example-owner\/ai-assets \(mechanical\); initialBaselineSha is the commit recorded by the downstream provenance file governance\/upstream-provenance\.json/);
    const data = YAML.parse(scenario.workspace.read("sdlc.yaml"));
    assert.deepEqual(data.dependencyEdges, [edgeOf({ setupSteps: installStep(run) })]);
    assert.deepEqual(data.projects.find((entry) => entry.repo === INSTANCE), cascadeOf().projects[1]);
    assertSchemaValid({ projects: data.projects, dependencyEdges: data.dependencyEdges });
    assert.equal(scenario.reconcile.calls.length, 1);
  } finally {
    await scenario.cleanup();
  }
});

test("aiam cascade: an instance with an engine block that is wrong is onboarded with a warning and an edge that has no setup step", async () => {
  const repo = (id, files) => ({ id, defaultBranch: "main", headSha: "a".repeat(40), files });
  const scenario = await createScenario({
    fake: { repos: { [UPSTREAM]: repo(9001, { "README.md": "# upstream\n" }), [INSTANCE]: repo(9002, instanceFiles({ engine: { ...GITHUB_ENGINE, private: "yes" } })) } },
    workspace: { manifest: readFixture("manifest.empty.yaml") },
  });
  try {
    const result = await scenario.onboard(["--repo", UPSTREAM, "--downstream", INSTANCE], { env: scenario.env(scenario.appCredentials()) });
    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stderr, /warning: example-owner\/ai-assets: governance\/policy\.yaml: engine\.private must be true or false/);
    assert.deepEqual(YAML.parse(scenario.workspace.read("sdlc.yaml")).dependencyEdges, [edgeOf()]);
  } finally {
    await scenario.cleanup();
  }
});

// --- parity with `aiam sdlc-preset` ------------------------------------------------------------------------------------------

const AIAM_SRC = process.env.AIAM_SRC;
const PYTHON = process.env.AIAM_PYTHON ?? "python";

test("aiam parity: `aiam sdlc-preset` prints the objects that this synthesis builds, on the same repositories (set AIAM_SRC to run it)", { skip: AIAM_SRC ? false : "set AIAM_SRC to the src directory of an aiam checkout to compare with `aiam sdlc-preset`" }, async (t) => {
  const cases = {
    "private engine": instanceFiles({ engine: ENGINES.private[0] }),
    "public engine": instanceFiles({ engine: ENGINES.public[0] }),
    "pypi engine": instanceFiles({ engine: ENGINES.pypi[0] }),
    "no engine": instanceFiles(),
    "no upstream": instanceFiles({ engine: ENGINES.private[0], sync: false }),
    "manifests and a build script": instanceFiles({ extra: { "package.json": JSON.stringify({ scripts: { build: "tsc" } }), "pyproject.toml": "[project]\nname = 'x'\n", "tools/go.mod": "module example.com/tools\n" } }),
    "a custom CODEOWNERS path and provenance file": instanceFiles({ sync: { provenance_file: "governance/sync/provenance.json" }, policy: { codeowners_path: "docs/CODEOWNERS" }, codeowners: null, extra: { "docs/CODEOWNERS": "* @docs-owner\n" } }),
    "a conventional provenance name and no upstream": instanceFiles({ sync: false, extra: { "vendor/source.json": JSON.stringify({ commit: COMMIT }) } }),
  };
  for (const [label, files] of Object.entries(cases)) {
    const dir = tree(t, files);
    execFileSync("git", ["init", "-q", "-b", "main"], { cwd: dir });
    execFileSync("git", ["remote", "add", "origin", `https://github.com/${INSTANCE}.git`], { cwd: dir });
    const { repo, defaultBranch } = localIdentity(dir);
    const expected = await presetOf(await inspectRepository(localReader(dir), { repo, defaultBranch, headSha: null }));
    const ran = spawnSync(PYTHON, ["-m", "aiam", "--root", dir, "sdlc-preset"], { encoding: "utf8", env: { ...process.env, PYTHONPATH: AIAM_SRC, PYTHONIOENCODING: "utf-8" } });
    assert.equal(ran.status, 0, `${label}: ${ran.stderr}`);
    assert.deepEqual(JSON.parse(ran.stdout), expected, label);
    assertSchemaValid(JSON.parse(ran.stdout), `${label}: `);
  }
});
