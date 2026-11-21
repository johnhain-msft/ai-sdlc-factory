// Prompt wording and the pull-request result keys as manifest data (design section E7).
//
//  * prompts.reportExamples: the reports that a drift or implementation prompt names as examples of "a report of their own"; none by default.
//  * prompts.pullRequestBodyItems: what the body of an AI cascade's pull request lists besides the range of commits; "the adapted files" by default.
//  * adaptation.pullRequestResult: a free-form map { <key>: <glob> }; the result of the run has one array of base names for each key, in manifest order.
//
// An adopter keeps its chosen wording byte for byte by declaring the two knobs, so the exact example sentences are the goldens below.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { run as pullRequestResult, adaptedNames } from "../src/ai-pull-request-result.mjs";
import { renderFleet } from "../src/reconcile.mjs";
import { bodyOf } from "./helpers/rendered.mjs";
import { createWorkspace, referenceRequest } from "./helpers/mini-fleet.mjs";
import { createWorkspace as s3Workspace, edge as s3Edge, sha } from "./s3/helpers/fixtures.mjs";
import { invoke } from "./s2/helpers/run-script.mjs";
import { cleanEnv, createFakeFetch, json } from "./s2/helpers/stub-server.mjs";

function render(t, mutate) {
  const work = createWorkspace(t, { mutate });
  const result = renderFleet(referenceRequest(), { cwd: work.dir });
  assert.equal(result.ok, true, JSON.stringify(result.result));
  return result.files;
}
function failures(t, mutate) {
  const work = createWorkspace(t, { mutate });
  const result = renderFleet(referenceRequest(), { cwd: work.dir });
  assert.equal(result.ok, false, "the render was expected to be refused");
  return result.result.validationResults.flatMap((entry) => entry.errors);
}
const body = (files, id) => bodyOf(files.get(`.github/workflows/${id}.md`));

// An example's legacy sentences: both reports named, and a custom description of the adapted files. The report sections that the drift sentence leaves out when they are
// empty are the ones of the change policy: under the default, corrections-only, ## For a human is one of them; under judgement-and-flag there is no such section.
const driftSentence = (leftOut) => `When the registration instructions above define a report of their own (such as \`reports/audit-report.md\` or \`reports/improvement-report.md\`), write that report as they say on every run, a dry run and a run that changes nothing included, because the checks that run after you look for it; the body of the issue is that report followed by the sections below other than \`## Summary\`. Otherwise the body has these sections, in this order, and leaves out ${leftOut} when they would be empty:`;
const LEGACY_DRIFT = driftSentence("`## Recommended`, `## Could not confirm` and `## For a human`");
const LEGACY_DRIFT_WITHOUT_FOR_A_HUMAN = driftSentence("`## Recommended` and `## Could not confirm`");
const LEGACY_IMPLEMENT = "When the registration instructions define a report of their own (such as `reports/audit-report.md` or `reports/improvement-report.md`), write it as they say, because the checks that run after you look for it.";
const LEGACY_PULL_REQUEST = "Its body lists `previous_sha..upstream_sha`, the `correlation_id` of `dispatch-inputs.json`, the adapted pages and views, and anything a reviewer must check by hand.";
const KNOBS = { reportExamples: ["reports/audit-report.md", "reports/improvement-report.md"], pullRequestBodyItems: "the adapted pages and views" };

// ---- the wording ------------------------------------------------------------------------------------------------------------------------------

test("with two prompt knobs the three declared sentences are reproduced byte for byte", (t) => {
  const files = render(t, (manifest) => (manifest.prompts = structuredClone(KNOBS)));
  for (const id of ["drift-docs-site", "drift-lab-content"]) assert.ok(body(files, id).includes(LEGACY_DRIFT), id);
  for (const id of ["implement-docs-site", "implement-lab-content"]) assert.ok(body(files, id).includes(LEGACY_IMPLEMENT), id);
  assert.ok(body(files, "cascade-ai-lab-to-hub").includes(LEGACY_PULL_REQUEST));
});

test("the drift sentence names the report sections of the change policy: one more under corrections-only and corrections-and-additions, which have a ## For a human, than under judgement-and-flag", (t) => {
  for (const [policy, sentence] of [["corrections-only", LEGACY_DRIFT], ["corrections-and-additions", LEGACY_DRIFT], ["judgement-and-flag", LEGACY_DRIFT_WITHOUT_FOR_A_HUMAN]]) {
    const files = render(t, (manifest) => {
      manifest.prompts = structuredClone(KNOBS);
      manifest.projects[0].driftAudit.changePolicy = policy;
    });
    assert.ok(body(files, "drift-docs-site").includes(sentence), policy);
    assert.equal(body(files, "drift-docs-site").includes(sentence === LEGACY_DRIFT ? LEGACY_DRIFT_WITHOUT_FOR_A_HUMAN : LEGACY_DRIFT), false, `${policy}: only its own sentence`);
  }
});

test("with no prompts block the prompts contain no adopter report paths or custom adapted-file wording", (t) => {
  const files = render(t);
  for (const [file, text] of files) {
    if (!file.endsWith(".md")) continue;
    assert.doesNotMatch(text, /reports\/audit-report\.md|reports\/improvement-report\.md|adapted pages and views/, file);
  }
  assert.ok(body(files, "drift-docs-site").includes("When the registration instructions above define a report of their own, write that report as they say on every run,"));
  assert.ok(body(files, "implement-docs-site").includes("When the registration instructions define a report of their own, write it as they say, because the checks that run after you look for it."));
  assert.ok(body(files, "cascade-ai-lab-to-hub").includes("Its body lists `previous_sha..upstream_sha`, the `correlation_id` of `dispatch-inputs.json`, the adapted files, and anything a reviewer must check by hand."));
});

test("the examples are joined as the sentence needs: one, two or three or more", (t) => {
  const phrase = (examples) => {
    const files = render(t, (manifest) => (manifest.prompts = { reportExamples: examples }));
    const found = /define a report of their own( \(such as [^)]*\))?, write that report/.exec(body(files, "drift-docs-site"));
    assert.ok(found, JSON.stringify(examples));
    return found[1] ?? "";
  };
  assert.equal(phrase([]), "");
  assert.equal(phrase(["a.md"]), " (such as `a.md`)");
  assert.equal(phrase(["a.md", "b/c.md"]), " (such as `a.md` or `b/c.md`)");
  assert.equal(phrase(["a.md", "b.md", "c.md"]), " (such as `a.md`, `b.md` or `c.md`)");
  assert.equal(phrase(["a.md", "b.md", "c.md", "d.md"]), " (such as `a.md`, `b.md`, `c.md` or `d.md`)");
});

test("pullRequestBodyItems is the text that the pull request lists, and nothing else of the sentence changes", (t) => {
  const files = render(t, (manifest) => (manifest.prompts = { pullRequestBodyItems: "the regenerated pages, and the changed config" }));
  assert.ok(body(files, "cascade-ai-lab-to-hub").includes("the `correlation_id` of `dispatch-inputs.json`, the regenerated pages, and the changed config, and anything a reviewer must check by hand."));
  const plain = render(t);
  const changed = body(files, "cascade-ai-lab-to-hub").split("\n");
  const original = body(plain, "cascade-ai-lab-to-hub").split("\n");
  assert.equal(changed.length, original.length);
  assert.deepEqual(changed.filter((line, index) => line !== original[index]).length, 1, "one line differs");
  assert.equal(body(files, "cascade-mechanical-docs-to-hub"), body(plain, "cascade-mechanical-docs-to-hub"), "a mechanical cascade has no such sentence");
});

test("a prompts block changes nothing but those sentences: the frontmatter of every workflow is the same", (t) => {
  const before = render(t);
  const after = render(t, (manifest) => (manifest.prompts = structuredClone(KNOBS)));
  for (const [file, text] of before) {
    const other = after.get(file);
    if (!file.endsWith(".md")) {
      assert.equal(other, text, file);
      continue;
    }
    assert.equal(text.slice(0, text.indexOf("\n---\n", 4)), other.slice(0, other.indexOf("\n---\n", 4)), `${file}: the frontmatter`);
  }
});

// ---- the schema ---------------------------------------------------------------------------------------------------------------------------

test("prompts.reportExamples is a list of plain relative paths, each once, and pullRequestBodyItems is one line of at most 200 characters", (t) => {
  render(t, (manifest) => (manifest.prompts = { reportExamples: ["a.md", "docs/b.md"], pullRequestBodyItems: "x".repeat(200) }));
  render(t, (manifest) => (manifest.prompts = {}));
  const bad = [
    ["reportExamples that is not a list", { reportExamples: "a.md" }],
    ["a duplicate example", { reportExamples: ["a.md", "a.md"] }],
    ["an example with a backtick, which would end its code span", { reportExamples: ["a`b.md"] }],
    ["an example with a space", { reportExamples: ["a b.md"] }],
    ["an absolute example", { reportExamples: ["/a.md"] }],
    ["an example that leaves the repository", { reportExamples: ["../a.md"] }],
    ["an empty example", { reportExamples: [""] }],
    ["an example of 201 characters", { reportExamples: [`${"a".repeat(198)}.md`.padEnd(201, "x")] }],
    ["an empty pullRequestBodyItems", { pullRequestBodyItems: "" }],
    ["pullRequestBodyItems of 201 characters", { pullRequestBodyItems: "x".repeat(201) }],
    ["pullRequestBodyItems with a line break", { pullRequestBodyItems: "a\nb" }],
    ["a key that is not part of the block", { surprise: true }],
  ];
  for (const [label, block] of bad) {
    const errors = failures(t, (manifest) => (manifest.prompts = structuredClone(block)));
    assert.ok(errors.some((error) => error.startsWith("schema-validation: ") && error.includes("prompts")), `${label}: ${errors.join(" | ")}`);
  }
  const opener = failures(t, (manifest) => (manifest.prompts = { pullRequestBodyItems: "${{ github.actor }}" }));
  assert.ok(opener.some((error) => error.startsWith("manifest-expression-opener: ") && error.includes("/prompts/pullRequestBodyItems")), opener.join("\n"));
});

// ---- the result keys ------------------------------------------------------------------------------------------------------------------------

const aiEdge = (manifest) => manifest.dependencyEdges[1];

test("adaptation.pullRequestResult is a map from a name to a glob; the names are plain keys that the result does not use itself", (t) => {
  render(t, (manifest) => (aiEdge(manifest).adaptation = { pullRequestResult: { pages: "site/pages/*.md", components: "site/**/*.tsx", a1: "x/*" } }));
  render(t, (manifest) => (aiEdge(manifest).adaptation = { pullRequestResult: {} }));
  const bad = [
    ["a reserved key outcome", { outcome: "a/*" }],
    ["a reserved key prNumber", { prNumber: "a/*" }],
    ["a reserved key prUrl", { prUrl: "a/*" }],
    ["a reserved key recordedCommit", { recordedCommit: "a/*" }],
    ["a key that starts with a capital", { Pages: "a/*" }],
    ["a key that starts with a digit", { "1pages": "a/*" }],
    ["a key with a dash", { "my-pages": "a/*" }],
    ["a key of 41 characters", { [`a${"b".repeat(40)}`]: "a/*" }],
    ["a value that is not a glob", { pages: "../a/*" }],
    ["a value that is not a string", { pages: 7 }],
  ];
  for (const [label, map] of bad) {
    const errors = failures(t, (manifest) => (aiEdge(manifest).adaptation = { pullRequestResult: structuredClone(map) }));
    assert.ok(errors.some((error) => error.startsWith("schema-validation: ") && error.includes("pullRequestResult")), `${label}: ${errors.join(" | ")}`);
  }
});

const UPSTREAM_SHA = sha("upstream");
const PR_FILES = ["site/pages/index.md", "site/pages/about.md", "site/pages/about.md.orig", "site/components/Header.tsx", "site/components/Footer.tsx", "README.md"];

/** The script against a stub that answers the pull request's file list: a workspace whose manifest holds `edge`, and the poll-state line. */
async function resultOf(t, { map, poll = { outcome: "pr-opened", prNumber: 7, prUrl: "https://github.example/acme/portal/pull/7" }, files = PR_FILES, env = {} }) {
  const edge = s3Edge({ ...(map === undefined ? {} : { adaptation: { pullRequestResult: map } }) });
  const workspace = s3Workspace({ edges: [edge] });
  t.after(() => workspace.cleanup());
  fs.writeFileSync(workspace.path("poll-state-result.json"), `${JSON.stringify(poll)}\n`);
  const outputFile = workspace.path("github-output");
  fs.writeFileSync(outputFile, "");
  const fake = createFakeFetch((entry) => (entry.path === "/repos/acme/portal/pulls/7/files" ? json(200, files.map((filename) => ({ filename }))) : json(404, { message: "Not Found" })));
  const result = await invoke(pullRequestResult, ["--slug", edge.upstreamSlug, "--poll-state-result", workspace.path("poll-state-result.json")], {
    env: cleanEnv({ GITHUB_WORKSPACE: workspace.dir, UPSTREAM_SHA, GH_TOKEN: "ghs_fixturetoken", GITHUB_OUTPUT: outputFile, SDLC_MANIFEST: "", ...env }),
    cwd: workspace.dir,
    fetch: fake,
  });
  const last = result.stdout.trimEnd().split("\n").at(-1);
  return { ...result, fake, value: result.code === 0 ? JSON.parse(last) : null, output: fs.readFileSync(outputFile, "utf8") };
}

test("the result has one array of base names for each key of the map, in the order of the manifest, after the four fixed keys", async (t) => {
  const result = await resultOf(t, { map: { pages: "site/pages/*.md", components: "site/**/*.tsx" } });
  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(Object.keys(result.value), ["outcome", "prNumber", "prUrl", "recordedCommit", "pages", "components"]);
  assert.deepEqual(result.value, {
    outcome: "pr-opened",
    prNumber: 7,
    prUrl: "https://github.example/acme/portal/pull/7",
    recordedCommit: UPSTREAM_SHA,
    pages: ["about", "index"],
    components: ["Footer", "Header"],
  });
  assert.equal(result.output, `result=${JSON.stringify(result.value)}\n`, "the same line is the output of the step");
  const reversed = await resultOf(t, { map: { components: "site/**/*.tsx", pages: "site/pages/*.md" } });
  assert.deepEqual(Object.keys(reversed.value).slice(4), ["components", "pages"], "manifest order");
  assert.equal(result.fake.requests.length, 1, "one read of the list of files");
});

test("an edge that names no keys prints no arrays and reads no files", async (t) => {
  for (const map of [undefined, {}]) {
    const result = await resultOf(t, { map });
    assert.equal(result.code, 0, result.stderr);
    assert.deepEqual(result.value, { outcome: "pr-opened", prNumber: 7, prUrl: "https://github.example/acme/portal/pull/7", recordedCommit: UPSTREAM_SHA });
    assert.equal(result.fake.requests.length, 0);
  }
});

test("a run with no pull request has an empty array for each key and reads no files", async (t) => {
  const result = await resultOf(t, { map: { pages: "site/pages/*.md", components: "site/**/*.tsx" }, poll: { outcome: "noop-no-changes" } });
  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(result.value, { outcome: "noop-no-changes", prNumber: null, prUrl: null, recordedCommit: UPSTREAM_SHA, pages: [], components: [] });
  assert.equal(result.fake.requests.length, 0);
});

test("a key that the manifest could not have passed the schema with is refused at run time, before any request", async (t) => {
  for (const map of [{ outcome: "a/*" }, { prUrl: "a/*" }, { "bad-key": "a/*" }, { Upper: "a/*" }]) {
    const result = await resultOf(t, { map });
    assert.equal(result.code, 2, JSON.stringify(map));
    assert.match(result.stderr, /pullRequestResult/);
    assert.equal(result.fake.requests.length, 0);
  }
});

test("adaptedNames reads one glob: the sorted base names without the last extension, each once", () => {
  assert.deepEqual(adaptedNames(PR_FILES, "site/pages/*.md"), ["about", "index"]);
  assert.deepEqual(adaptedNames(PR_FILES, "site/**/*.tsx"), ["Footer", "Header"]);
  assert.deepEqual(adaptedNames(PR_FILES, undefined), []);
  assert.deepEqual(adaptedNames(PR_FILES, ""), []);
  assert.equal(path.posix.basename("a/b.md"), "b.md");
  // a name that two matching files share is listed once, and only the last extension goes: about.test.tsx is about.test
  assert.deepEqual(adaptedNames(["site/a/index.md", "site/b/index.md", "site/b/about.md"], "site/**/*.md"), ["about", "index"]);
  assert.deepEqual(adaptedNames(["site/pages/about.test.tsx", "site/pages/Header.stories.tsx", "site/pages/plain.tsx"], "site/pages/*.tsx"), ["Header.stories", "about.test", "plain"]);
});
