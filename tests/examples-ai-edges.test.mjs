// The three ai-adaptation edges of examples/sdlc.yaml: what the AI workflow renders from and what the immutable gates lock. The fleet's edges differ on purpose (one has a
// classifier and a helper, one a runs listing, one a plain git diff), so each is pinned on its own data. This file reads examples/ itself, never the SDLC_PRESET_ROOT seam.
import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import YAML from "yaml";
import { engineAbs } from "./helpers/preset.mjs";

const manifest = YAML.parse(fs.readFileSync(engineAbs("examples", "sdlc.yaml"), "utf8"));
const aiEdges = manifest.dependencyEdges.filter((edge) => edge.mode === "ai-adaptation");
const edgeOf = (id) => aiEdges.find((edge) => edge.edgeId === id);
const sorted = (list) => [...list].sort();

const IDENTITY = [
  ["lab-to-hub", "lab-content", "LAB_CONTENT", "example-org/lab-content"],
  ["pipelines-to-hub", "demo-pipelines", "DEMO_PIPELINES", "example-org/demo-pipelines"],
  ["course-to-hub", "course-template", "COURSE_TEMPLATE", "example-org/course-template"],
];

const PROVENANCE = {
  "lab-to-hub": "content/pages/source-inputs.json",
  "pipelines-to-hub": "content/pipelines/provenance.json",
  "course-to-hub": "content/course/provenance.json",
};

const ALLOWED = {
  "lab-to-hub": [
    "README.md", "content/pages/index.ts", "content/pages/p*.ts", "content/pages/provenance.json", "content/pages/source-inputs.json", "public/pages/**", "tests/pages.test.ts",
    "apps/site/sources.json", "apps/site/README.md", "apps/site/client/src/views/*.tsx",
  ],
  "pipelines-to-hub": ["content/pipelines/provenance.json", "content/pipelines/capture/fetch-run-data.mjs", "content/pipelines/run-data.json", "public/pipelines/**", "tests/pipelines.test.ts"],
  "course-to-hub": ["content/course/provenance.json", "content/course/src/**", "public/course/**", "tests/course.test.ts"],
};

const GATES = ["npm run typecheck", "npm run lint", "npm test"];
const VERIFY_HEAD = {
  "lab-to-hub": [
    "npm run build:content", "npm run build:views", 'git -C "$GITHUB_WORKSPACE/hub" status --porcelain', "npm run build", "SITE_ORIGIN=https://site.example.com npm run build:catalog",
    ...GATES, "npm run test:site", "npx playwright test tests/browser/site.spec.ts",
  ],
  "pipelines-to-hub": ["npm run build:content", 'git -C "$GITHUB_WORKSPACE/hub" status --porcelain', "npm run build", ...GATES],
  "course-to-hub": ["npm run build:content", 'git -C "$GITHUB_WORKSPACE/hub" status --porcelain', "npm run build", ...GATES],
};
const POST_RUN = ["a dry run must not leave a commit", "committed provenance records upstream_sha", "the upstream checkout stays read-only"];

test("the fleet has exactly three ai-adaptation edges, into the hub, with the keys, slugs, repositories and state variables of the fleet", () => {
  assert.deepEqual(aiEdges.map((edge) => edge.edgeId), IDENTITY.map(([id]) => id));
  for (const [id, key, slug, repo] of IDENTITY) {
    const edge = edgeOf(id);
    assert.equal(edge.downstreamRepo, "example-org/hub", id);
    assert.equal(edge.upstreamKey, key, id);
    assert.equal(edge.upstreamSlug, slug, id);
    assert.equal(edge.upstreamRepo, repo, id);
    assert.equal(edge.stateVariable, `SDLC_SYNC_STATE_${slug}`, id);
  }
});

test("every edge carries the data its workflow needs, and none of it is empty", () => {
  for (const edge of aiEdges) {
    for (const field of ["preflightCommands", "acceptCommands", "buildCommands", "verifyCommands", "allowedFiles"]) {
      assert.ok(Array.isArray(edge[field]) && edge[field].length > 0, `${edge.edgeId}.${field}`);
      for (const entry of edge[field]) assert.ok(typeof entry === "string" && entry.trim() !== "", `${edge.edgeId}.${field}`);
    }
    assert.ok(edge.adaptationInstructions.trim() !== "", `${edge.edgeId}.adaptationInstructions`);
    const gates = edge.immutableGates;
    assert.ok(gates.zeroDiffPaths.length > 0, `${edge.edgeId}.immutableGates.zeroDiffPaths`);
    assert.ok(gates.lockedTestBlocks.length > 0 && gates.lockedTestBlocks.every((entry) => entry.blocks.length > 0), `${edge.edgeId}.immutableGates.lockedTestBlocks`);
    assert.ok(Object.keys(gates.inProcessInvariants).length > 0, `${edge.edgeId}.immutableGates.inProcessInvariants`);
    assert.equal(edge.autoMerge, false, edge.edgeId);
  }
});

test("the workflow identities, the provenance files and the files that a cascade may change are the ones of the fleet", () => {
  for (const edge of aiEdges) {
    assert.equal(edge.branchName, `sdlc/cascade-${edge.edgeId}`);
    assert.equal(edge.closeOlderKey, `sdlc-cascade-${edge.edgeId}`);
    assert.equal(edge.provenanceFile, PROVENANCE[edge.edgeId], edge.edgeId);
    assert.equal(edge.provenanceJsonPointer, "/commit", edge.edgeId);
    assert.deepEqual(sorted(edge.allowedFiles), sorted(ALLOWED[edge.edgeId]), `${edge.edgeId}: the allowed files, whatever their order`);
    assert.ok(edge.allowedFiles.includes(edge.provenanceFile), `${edge.edgeId}: the provenance file may be changed`);
  }
});

test("the sync scopes: the classifier edge and the runs edge declare their own, the plain edge takes the default, and a declared list always starts with both", () => {
  assert.deepEqual(edgeOf("lab-to-hub").syncScopes, ["both", "content-only", "app-only"]);
  assert.deepEqual(edgeOf("pipelines-to-hub").syncScopes, ["both", "runs-only"]);
  assert.equal(edgeOf("course-to-hub").syncScopes, undefined);
  for (const edge of aiEdges.filter((candidate) => candidate.syncScopes)) {
    assert.equal(edge.syncScopes[0], "both", edge.edgeId);
    assert.equal(new Set(edge.syncScopes).size, edge.syncScopes.length, `${edge.edgeId}: no scope twice`);
    for (const scope of edge.syncScopes) assert.match(scope, /^[a-z]+(?:-[a-z]+)*$/, `${edge.edgeId}: ${scope}`);
  }
});

test("each edge's verifyCommands are its rebuild commands and gates, then the three post-run checks, which are comments", () => {
  for (const edge of aiEdges) {
    const { verifyCommands } = edge;
    assert.deepEqual(verifyCommands.slice(0, VERIFY_HEAD[edge.edgeId].length), VERIFY_HEAD[edge.edgeId], edge.edgeId);
    const checks = verifyCommands.slice(VERIFY_HEAD[edge.edgeId].length);
    assert.deepEqual(checks.map((command) => command.split("\n")[0].replace(/^#\s*post-run check:\s*/, "")), POST_RUN, `${edge.edgeId}: the post-run checks, in order`);
    for (const command of checks) assert.match(command, /^# post-run check: /, edge.edgeId);
  }
  assert.deepEqual(aiEdges.map((edge) => edge.verifyCommands.length), [13, 9, 9]);
});

test("lab-to-hub: the report check and the source check run before the build, and accept runs the same two with --accept", () => {
  const edge = edgeOf("lab-to-hub");
  assert.deepEqual(edge.preflightCommands, [
    "npm run check:inputs -- <checkout>",
    'node "$GITHUB_WORKSPACE/scripts/check-sources.mjs" --downstream "$GITHUB_WORKSPACE/hub" --upstream <checkout> --commit "$TARGET_SHA"',
  ]);
  assert.deepEqual(edge.acceptCommands, [
    "npm run check:inputs -- <checkout> --accept",
    'node "$GITHUB_WORKSPACE/scripts/check-sources.mjs" --downstream "$GITHUB_WORKSPACE/hub" --upstream <checkout> --commit "$UPSTREAM_SHA" --accept',
  ]);
  assert.deepEqual(edge.buildCommands, ["npm run build:content"]);
  assert.deepEqual(edge.preflightChecks, [{ scope: "content-only", classifier: 'node "$GITHUB_WORKSPACE/scripts/classify-report.mjs"' }, { scope: "app-only" }]);
});

test("pipelines-to-hub and course-to-hub: each accept writes the exact provenance object of its upstream into its provenance file, and each has the build and preflight of its shape", () => {
  for (const [id, , , repo] of IDENTITY.slice(1)) {
    const edge = edgeOf(id);
    assert.equal(edge.acceptCommands.length, 1, id);
    assert.ok(edge.acceptCommands[0].includes(`JSON.stringify({ repository: "${repo}", commit: process.env.UPSTREAM_SHA }, null, 2)`), `${id}: the provenance object`);
    assert.ok(edge.acceptCommands[0].includes(`writeFileSync("${edge.provenanceFile}"`), `${id}: the provenance file`);
  }
  const pipelines = edgeOf("pipelines-to-hub");
  assert.deepEqual(pipelines.buildCommands, ["node content/pipelines/capture/fetch-run-data.mjs", "npm run build:content"], "the run data is captured, then built");
  assert.deepEqual(pipelines.preflightCommands, ['gh api "repos/example-org/demo-pipelines/actions/runs?per_page=100"']);
  assert.deepEqual(pipelines.preflightChecks, [{ scope: "runs-only", classifier: 'node "$GITHUB_WORKSPACE/scripts/classify-runs.mjs"', noopAction: "noop-unchanged-snapshot" }]);
  const course = edgeOf("course-to-hub");
  assert.deepEqual(course.buildCommands, ["npm run build:content"]);
  assert.deepEqual(course.preflightCommands, ['git -C <checkout> diff --quiet "$LAST_MERGED_SHA" "$TARGET_SHA" -- units samples src theme index.html README.md']);
  assert.equal(course.preflightChecks, undefined);
  assert.equal(course.onCommitOnlyAdvance, "bump-provenance");
});

test("the adaptation data that the helpers and the run report read: the report files, the helper's manifest and the two result keys", () => {
  assert.deepEqual(edgeOf("lab-to-hub").adaptation, {
    preflightReports: ["input-report.txt", "source-check.txt"],
    helpers: { sourceCheck: { manifest: "apps/site/sources.json" } },
    pullRequestResult: { adaptedPages: "content/pages/p*.ts", adaptedViews: "apps/site/client/src/views/*.tsx" },
  });
  assert.deepEqual(edgeOf("pipelines-to-hub").adaptation, { preflightReports: ["upstream-runs.json"] });
  assert.equal(edgeOf("course-to-hub").adaptation, undefined);
});

test("the immutable gates of each edge: the files that stay as they are, the test blocks that stay locked, and the in-process invariants", () => {
  const COMMON = ["content/rules.ts", "content/types.ts", "kernel", "scripts", "tests/login.test.ts", "tests/runner.test.ts"];
  assert.deepEqual(edgeOf("lab-to-hub").immutableGates.zeroDiffPaths, [...COMMON, "apps/site/server/src/index.ts", "apps/site/server/src/sandbox.ts", "apps/site/server/tests/sandbox.test.ts"]);
  assert.deepEqual(edgeOf("pipelines-to-hub").immutableGates.zeroDiffPaths, COMMON);
  assert.deepEqual(edgeOf("course-to-hub").immutableGates.zeroDiffPaths, COMMON);
  assert.deepEqual(edgeOf("lab-to-hub").immutableGates.generatedPaths, ["public/**"]);
  assert.equal(edgeOf("pipelines-to-hub").immutableGates.generatedPaths, undefined);

  const locked = (id) => edgeOf(id).immutableGates.lockedTestBlocks.map((entry) => [entry.file, entry.blocks.map((block) => `${block.kind}: ${block.title}`), entry.lockedImports ?? []]);
  assert.deepEqual(locked("lab-to-hub"), [["tests/pages.test.ts", [
    "it: accepts every page of the course without errors or warnings", "it: gives every page a heading and a body", "it: keeps every page inside the length limits",
  ], []]]);
  assert.deepEqual(locked("pipelines-to-hub"), [["tests/pipelines.test.ts", ["describe: pipelines animated figure", "describe: pipelines sanitization"], ["findBannedTerms"]]]);
  assert.deepEqual(locked("course-to-hub"), [["tests/course.test.ts", [
    "it: gives every unit a title and a non-empty summary", "it: contains no banned terms, private framing or personal paths",
  ], []]]);

  const invariants = (id) => edgeOf(id).immutableGates.inProcessInvariants;
  assert.deepEqual(Object.keys(invariants("lab-to-hub")), ["frozenModules", "course", "check", "constants", "customerTerms"]);
  assert.deepEqual(invariants("lab-to-hub").constants, [
    { module: "content/rules.ts", export: "READING_WPM", value: 180 },
    { module: "content/rules.ts", export: "PAGE_WORDS", value: { target: 120, max: 200 } },
  ]);
  for (const id of ["pipelines-to-hub", "course-to-hub"]) assert.deepEqual(Object.keys(invariants(id)), ["frozenModules", "customerTerms"], id);
  for (const edge of aiEdges) assert.deepEqual(edge.immutableGates.inProcessInvariants.customerTerms, { module: "tests/support/terms.ts", export: "findBannedTerms" }, edge.edgeId);
});

test("no command of any edge spells the upstream checkout other than as <checkout>, and none names an absolute path of a machine", () => {
  for (const edge of manifest.dependencyEdges) {
    for (const command of [...edge.importCommands, ...edge.preflightCommands, ...edge.acceptCommands, ...edge.buildCommands]) {
      assert.equal(/upstream\//.test(command.replace(/--upstream\b/g, "")), false, `${edge.edgeId}: ${command}`);
      assert.equal(command.includes("$GITHUB_WORKSPACE/upstream"), false, `${edge.edgeId}: ${command}`);
      assert.equal(/(?<![A-Za-z0-9])[A-Za-z]:[\\/]|\/home\/|\/Users\//.test(command), false, `${edge.edgeId}: ${command}`);
    }
  }
});
