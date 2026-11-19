// The flag, the generated paths and the neutral names of the immutable-gate verifier (design sections E8, E9 and E10).
//
// E8: the downstream checkout is --downstream. --portfolio is accepted for one release as a deprecated alias (a notice on stderr; both given is a usage error),
// because the workflows that are committed in an orchestrator call the engine by flag: after an engine bump and before the next reconcile, the previous release's
// rendered workflows must still run. The renderer emits --downstream.
// E10: the files that the downstream generates (`public/**` for the adopter that this used to be written for) are the edge's `immutableGates.generatedPaths`.
// E9: the types are MechanicalCascadeResult and AiPullRequestResult: no adopter's name is left in the engine.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import YAML from "yaml";
import { gatePolicyFor, ManifestError } from "../src/adaptation/manifest.mjs";
import { renderFleet } from "../src/reconcile.mjs";
import { run } from "../src/verify-immutable-gates.mjs";
import { createWorkspace as miniWorkspace, miniManifest, referenceRequest } from "./helpers/mini-fleet.mjs";
import { frontmatterOf } from "./helpers/rendered.mjs";
import { forceRemove, tempDir } from "./s2/helpers/fixtures.mjs";
import { createRepo } from "./s2/helpers/git-fixture.mjs";
import { invoke } from "./s2/helpers/run-script.mjs";
import { cleanEnv } from "./s2/helpers/stub-server.mjs";

const SHA = "0123456789abcdef0123456789abcdef01234567";
const WORKFLOW = "cascade-ai-docs-to-hub";

/** A manifest with one AI edge whose gates are `gates`, and a downstream repository with two commits: the base, and a head that `change` makes. */
function world(t, { gates = { zeroDiffPaths: ["kernel"] }, allowedFiles = ["src/**", "public/**"], change = {} } = {}) {
  const root = tempDir("sdlc-gates-");
  t.after(() => forceRemove(root));
  const workspace = path.join(root, "orchestrator");
  fs.mkdirSync(workspace, { recursive: true });
  const edge = { edgeId: "docs-to-hub", mode: "ai-adaptation", downstreamRepo: "example-org/hub", allowedFiles, immutableGates: gates };
  fs.writeFileSync(path.join(workspace, "sdlc.yaml"), YAML.stringify({ projects: [], dependencyEdges: [edge] }));
  const repo = createRepo({ "src/app.ts": "export const app = 1;\n", "public/bundle.js": "export const bundle = 1;\n", "kernel/rules.ts": "export const rules = 1;\n" }, { dir: path.join(root, "hub") });
  const base = repo.head();
  if (Object.keys(change).length > 0) {
    for (const [file, text] of Object.entries(change)) repo.write(file, text);
    repo.commitAll("the agent's commit");
  }
  const hub = repo.dir;
  const env = (extra = {}) => cleanEnv({ GITHUB_WORKSPACE: workspace, SDLC_MANIFEST: "", ...extra });
  const verify = (flags) => invoke(run, flags, { env: env(), cwd: workspace });
  return { root, workspace, hub, base, verify, flags: (name = "--downstream") => [name, hub, "--base", base, "--workflow", WORKFLOW] };
}

// ---- E8: --downstream -------------------------------------------------------------------------------------------------------------------------

test("--downstream is the flag: the checkout that it names is verified and nothing is said about a deprecation", async (t) => {
  const w = world(t);
  const result = await w.verify(w.flags());
  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), { status: "ok", violatingFiles: [] });
  assert.doesNotMatch(result.stderr, /deprecated/);
});

test("--portfolio is a deprecated alias for one release: the same verdict, with a notice on stderr that says which flag to use", async (t) => {
  const w = world(t);
  const result = await w.verify(w.flags("--portfolio"));
  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), { status: "ok", violatingFiles: [] });
  assert.match(result.stderr, /--portfolio is deprecated; use --downstream/);
  const violating = world(t, { change: { "kernel/rules.ts": "export const rules = 2;\n" } });
  const refused = await violating.verify(violating.flags("--portfolio"));
  assert.equal(refused.code, 1, "a violation is a violation under either name");
  assert.deepEqual(JSON.parse(refused.stdout).violatingFiles, ["kernel/rules.ts"]);
  assert.match(refused.stderr, /--portfolio is deprecated/);
});

test("both --downstream and --portfolio is a usage error, and neither is a usage error that names --downstream", async (t) => {
  const w = world(t);
  const both = await w.verify([...w.flags(), "--portfolio", w.hub]);
  assert.equal(both.code, 2);
  assert.match(both.stderr, /--portfolio is the deprecated name of --downstream; give one of them/);
  assert.equal(both.stdout, "", "no verdict was decided");
  const neither = await w.verify(["--base", w.base, "--workflow", WORKFLOW]);
  assert.equal(neither.code, 2);
  assert.match(neither.stderr, /--downstream is required/);
  assert.doesNotMatch(neither.stderr, /--portfolio/);
});

test("the messages of the verifier say --downstream, whichever name the caller used", async (t) => {
  const w = world(t);
  const missing = path.join(w.root, "no-such-directory");
  const direct = await w.verify(["--downstream", missing, "--base", w.base, "--workflow", WORKFLOW]);
  assert.equal(direct.code, 2);
  assert.match(direct.stderr, /--downstream is not a directory/);
  const aliased = await w.verify(["--portfolio", missing, "--base", w.base, "--workflow", WORKFLOW]);
  assert.equal(aliased.code, 2);
  assert.match(aliased.stderr, /--downstream is not a directory/);
  const plain = await w.verify(["--downstream", w.workspace, "--base", w.base, "--workflow", WORKFLOW]);
  assert.equal(plain.code, 2);
  assert.match(plain.stderr, /--downstream must be the root of a git work tree/);
  assert.equal(path.basename(w.hub), "hub");
});

test("the renderer emits --downstream for the verification gate of an AI cascade, and --portfolio nowhere", (t) => {
  const work = miniWorkspace(t);
  const result = renderFleet(referenceRequest(), { cwd: work.dir });
  assert.equal(result.ok, true, JSON.stringify(result.result));
  let gates = 0;
  for (const [file, text] of result.files) {
    assert.doesNotMatch(text, /--portfolio/, file);
    if (!file.endsWith("cascade-ai-lab-to-hub.md")) continue;
    for (const step of frontmatterOf(text)["post-steps"]) {
      if (!String(step.run).includes("verify-immutable-gates.mjs")) continue;
      gates += 1;
      assert.match(step.run, / --downstream "\$GITHUB_WORKSPACE\/hub" --base "\$BASE_SHA" --workflow cascade-ai-lab-to-hub$/);
    }
  }
  assert.equal(gates, 1, "the AI cascade has one gate step, and it is the one that was checked");
  assert.ok(miniManifest().dependencyEdges.some((edge) => edge.mode === "ai-adaptation"));
});

// ---- E10: generatedPaths ------------------------------------------------------------------------------------------------------------------------

const BANNED = "it.only('x', () => {});\n";

test("a file that the downstream generates is not an editable module: the constructs that a gate bans are not looked for in it", async (t) => {
  const generated = world(t, { gates: { zeroDiffPaths: ["kernel"], generatedPaths: ["public/**"] }, change: { "public/bundle.js": BANNED } });
  const ok = await generated.verify(generated.flags());
  assert.equal(ok.code, 0, ok.stderr);
  assert.deepEqual(JSON.parse(ok.stdout), { status: "ok", violatingFiles: [] });
  const other = world(t, { gates: { zeroDiffPaths: ["kernel"], generatedPaths: ["dist/**"] }, change: { "public/bundle.js": BANNED } });
  const refused = await other.verify(other.flags());
  assert.equal(refused.code, 1, "public/ is no longer generated, so it is an editable module like any other");
  assert.deepEqual(JSON.parse(refused.stdout).violatingFiles, ["public/bundle.js"]);
  assert.match(refused.stderr, /adds \.only/);
});

test("without generatedPaths nothing is generated: the engine does not know public/ any more", async (t) => {
  const w = world(t, { gates: { zeroDiffPaths: ["kernel"] }, change: { "public/bundle.js": BANNED } });
  const result = await w.verify(w.flags());
  assert.equal(result.code, 1, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout).violatingFiles, ["public/bundle.js"]);
});

test("an editable module is still checked, and a locked path is still locked, whatever is generated", async (t) => {
  const w = world(t, { gates: { zeroDiffPaths: ["kernel"], generatedPaths: ["public/**"] }, change: { "src/app.ts": BANNED, "kernel/rules.ts": "export const rules = 3;\n", "public/bundle.js": BANNED } });
  const result = await w.verify(w.flags());
  assert.equal(result.code, 1);
  assert.deepEqual(JSON.parse(result.stdout).violatingFiles, ["kernel/rules.ts", "src/app.ts"]);
});

test("gatePolicyFor returns generatedPaths, empty by default, and refuses data that is not a list of strings", () => {
  const document = (gates) => ({ dependencyEdges: [{ edgeId: "docs-to-hub", mode: "ai-adaptation", downstreamRepo: "example-org/hub", allowedFiles: ["src/**"], immutableGates: gates }] });
  assert.deepEqual(gatePolicyFor(document({ zeroDiffPaths: [] }), WORKFLOW).generatedPaths, []);
  assert.deepEqual(gatePolicyFor(document({ zeroDiffPaths: [], generatedPaths: ["public/**", "dist/**"] }), WORKFLOW).generatedPaths, ["public/**", "dist/**"]);
  for (const bad of ["public/**", [1], [""], { 0: "public/**" }]) {
    assert.throws(() => gatePolicyFor(document({ zeroDiffPaths: [], generatedPaths: bad }), WORKFLOW), (error) => error instanceof ManifestError && /generatedPaths/.test(error.message), JSON.stringify(bad));
  }
});

test("the manifest schema takes generatedPaths as a list of glob entries, and refuses anything else", (t) => {
  const render = (generatedPaths) => {
    const work = miniWorkspace(t, { mutate: (manifest) => (manifest.dependencyEdges[1].immutableGates.generatedPaths = generatedPaths) });
    return renderFleet(referenceRequest(), { cwd: work.dir });
  };
  assert.equal(render(["public/**", "dist/**"]).ok, true);
  assert.equal(render([]).ok, true);
  for (const bad of ["public/**", [1], ["../public"], ["/abs/**"], [""], ["public/**", "public/**"]]) {
    const result = render(bad);
    assert.equal(result.ok, false, JSON.stringify(bad));
    assert.ok(result.result.validationResults.flatMap((entry) => entry.errors).some((error) => error.startsWith("schema-validation: ") && error.includes("generatedPaths")), JSON.stringify(bad));
  }
});

// ---- E9: neutral names ----------------------------------------------------------------------------------------------------------------------------

test("no adopter's name is left in a type of the engine: MechanicalCascadeResult and AiPullRequestResult", () => {
  const root = path.resolve(import.meta.dirname, "..");
  const texts = {
    "schemas/sdlc-routing.schema.json": fs.readFileSync(path.join(root, "schemas", "sdlc-routing.schema.json"), "utf8"),
    "src/update-poll-state.mjs": fs.readFileSync(path.join(root, "src", "update-poll-state.mjs"), "utf8"),
    "src/ai-pull-request-result.mjs": fs.readFileSync(path.join(root, "src", "ai-pull-request-result.mjs"), "utf8"),
    "src/reconcile.mjs": fs.readFileSync(path.join(root, "src", "reconcile.mjs"), "utf8"),
  };
  const prefixedResult = /\b[A-Z][\w$]*(?:MechanicalCascade|AiPullRequest)Result\b/;
  assert.match("ExampleMechanicalCascadeResult ExampleAiPullRequestResult", prefixedResult, "the guard recognizes an adopter prefix");
  assert.doesNotMatch("MechanicalCascadeResult AiPullRequestResult", prefixedResult, "the engine's neutral names are not prefixes");
  for (const [file, text] of Object.entries(texts)) assert.doesNotMatch(text, prefixedResult, file);
  assert.match(texts["schemas/sdlc-routing.schema.json"], /"MechanicalCascadeResult"/);
  assert.match(texts["src/update-poll-state.mjs"], /MechanicalCascadeResult/);
  assert.match(texts["src/ai-pull-request-result.mjs"], /AiPullRequestResult/);
  assert.match(texts["src/reconcile.mjs"], /AiPullRequestResult/);
  assert.equal(SHA.length, 40);
});
