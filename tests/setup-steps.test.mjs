// The Node and tooling setup of a cascade workflow as edge data (design section E6): `nodeVersion` and `setupSteps`.
//
// A cascade installs the downstream's dependencies before the agent starts. The Node version was fixed at 24 and every non-Python edge also installed a browser for
// one adopter's end-to-end tests; the engine now installs no browser of its own. An edge says which Node it needs (default "24") and lists any further setup as
// `setupSteps`, rendered after the dependency installs for both the Node and the Python path, in the downstream checkout (or a directory of it).
import assert from "node:assert/strict";
import test from "node:test";
import { renderFleet } from "../src/reconcile.mjs";
import { frontmatterOf } from "./helpers/rendered.mjs";
import { createWorkspace, referenceRequest } from "./helpers/mini-fleet.mjs";

const EDGE_WORKFLOWS = { "docs-to-hub": "cascade-mechanical-docs-to-hub", "lab-to-hub": "cascade-ai-lab-to-hub" };
const edgeNamed = (manifest, edgeId) => manifest.dependencyEdges.find((edge) => edge.edgeId === edgeId);

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
const stepsOf = (files, edgeId) => frontmatterOf(files.get(`.github/workflows/${EDGE_WORKFLOWS[edgeId]}.md`)).steps;

const NODE24 = { name: "Set up Node.js 24", uses: "actions/setup-node@v4", with: { "node-version": "24" } };
const INSTALL_ROOT = { name: "Install dependencies (root)", run: "npm ci --include=dev", "working-directory": "hub" };
const EDGE_STEP = { name: "Install Microsoft Edge", run: "npx playwright install --with-deps msedge", workingDirectory: "." };

const sameSteps = (actual, expected, label) => {
  assert.deepEqual(actual, expected, label);
  assert.deepEqual(actual.map((step) => Object.keys(step)), expected.map((step) => Object.keys(step)), `${label}: key order`);
};

// ---- the default: a plain Node edge ---------------------------------------------------------------------------------------------------------

test("an edge with neither key sets up Node 24 and installs its dependencies, and nothing else: the engine installs no browser", (t) => {
  const files = render(t);
  for (const edgeId of Object.keys(EDGE_WORKFLOWS)) sameSteps(stepsOf(files, edgeId), [NODE24, INSTALL_ROOT], edgeId);
  for (const [file, text] of files) assert.doesNotMatch(text, /playwright|msedge|Microsoft Edge/, file);
});

test("setupSteps that reproduce the old step give the old steps, key for key", (t) => {
  const files = render(t, (manifest) => (edgeNamed(manifest, "lab-to-hub").setupSteps = [structuredClone(EDGE_STEP)]));
  sameSteps(stepsOf(files, "lab-to-hub"), [NODE24, INSTALL_ROOT, { name: "Install Microsoft Edge", run: "npx playwright install --with-deps msedge", "working-directory": "hub" }], "lab-to-hub");
  sameSteps(stepsOf(files, "docs-to-hub"), [NODE24, INSTALL_ROOT], "the other edge declares none and gets none");
});

test("nodeVersion is the version that is set up, in the step name and in the action", (t) => {
  for (const version of ["22", "22.4", "20.11.1"]) {
    const files = render(t, (manifest) => (edgeNamed(manifest, "lab-to-hub").nodeVersion = version));
    sameSteps(stepsOf(files, "lab-to-hub"), [{ name: `Set up Node.js ${version}`, uses: "actions/setup-node@v4", with: { "node-version": version } }, INSTALL_ROOT], version);
    sameSteps(stepsOf(files, "docs-to-hub"), [NODE24, INSTALL_ROOT], `${version}: another edge keeps 24`);
  }
});

// ---- where and when they run ----------------------------------------------------------------------------------------------------------------

test("a setup step runs in the downstream checkout, or in a directory of it, in the order that it is listed, after every dependency install", (t) => {
  const files = render(t, (manifest) => {
    const edge = edgeNamed(manifest, "lab-to-hub");
    edge.installDirectories = [".", "app/ui"];
    edge.setupSteps = [
      { name: "First", run: "echo first" },
      { name: "Second", run: "echo second", workingDirectory: "app/ui" },
      { name: "Third", run: "echo third", workingDirectory: "." },
    ];
  });
  sameSteps(stepsOf(files, "lab-to-hub"), [
    NODE24,
    INSTALL_ROOT,
    { name: "Install dependencies (app/ui)", run: "npm ci --include=dev", "working-directory": "hub/app/ui" },
    { name: "First", run: "echo first", "working-directory": "hub" },
    { name: "Second", run: "echo second", "working-directory": "hub/app/ui" },
    { name: "Third", run: "echo third", "working-directory": "hub" },
  ], "lab-to-hub");
});

test("the Python path has its setup steps too, after the installs, and none by default", (t) => {
  const python = (manifest) => {
    const edge = edgeNamed(manifest, "lab-to-hub");
    edge.pythonVersion = "3.12";
    edge.installDirectories = [".", "svc"];
  };
  const plain = render(t, python);
  sameSteps(stepsOf(plain, "lab-to-hub"), [
    { name: "Set up Python 3.12", uses: "actions/setup-python@v5", with: { "python-version": "3.12" } },
    { name: "Install dependencies (root)", run: 'python -m pip install -e ".[dev]"', "working-directory": "hub" },
    { name: "Install dependencies (svc)", run: 'python -m pip install -e ".[dev]"', "working-directory": "hub/svc" },
  ], "no setup steps: as before");
  const withSteps = render(t, (manifest) => {
    python(manifest);
    edgeNamed(manifest, "lab-to-hub").setupSteps = [{ name: "Generate stubs", run: "python -m tools.stubs", workingDirectory: "svc" }];
  });
  sameSteps(stepsOf(withSteps, "lab-to-hub").slice(3), [{ name: "Generate stubs", run: "python -m tools.stubs", "working-directory": "hub/svc" }], "after both installs");
});

test("an edge's setup is the edge's own: nothing of another workflow changes", (t) => {
  const before = render(t);
  const after = render(t, (manifest) => {
    const edge = edgeNamed(manifest, "lab-to-hub");
    edge.nodeVersion = "22";
    edge.setupSteps = [structuredClone(EDGE_STEP)];
  });
  for (const [file, text] of before) {
    if (file === ".github/workflows/cascade-ai-lab-to-hub.md") continue;
    assert.equal(after.get(file), text, file);
  }
  const changed = frontmatterOf(after.get(".github/workflows/cascade-ai-lab-to-hub.md"));
  const original = frontmatterOf(before.get(".github/workflows/cascade-ai-lab-to-hub.md"));
  delete changed.steps;
  delete original.steps;
  assert.deepEqual(changed, original, "only steps differs in the workflow");
});

// ---- the schema ------------------------------------------------------------------------------------------------------------------------------

test("nodeVersion is a version number of one to three parts, and setupSteps is a list of named commands", (t) => {
  for (const version of ["24", "22.4", "20.11.1", "8"]) render(t, (manifest) => (edgeNamed(manifest, "lab-to-hub").nodeVersion = version));
  render(t, (manifest) => (edgeNamed(manifest, "lab-to-hub").setupSteps = []));
  for (const bad of ["v24", "24.x", "24.1.2.3", "", "lts/*", " 24", "24 ", 24, null]) {
    const errors = failures(t, (manifest) => (edgeNamed(manifest, "lab-to-hub").nodeVersion = bad));
    assert.ok(errors.some((error) => error.startsWith("schema-validation: ") && error.includes("nodeVersion")), `${JSON.stringify(bad)}: ${errors.join(" | ")}`);
  }
  const badSteps = [
    ["not a list", { name: "x", run: "y" }],
    ["a step without a name", [{ run: "y" }]],
    ["a step without a command", [{ name: "x" }]],
    ["an empty name", [{ name: "", run: "y" }]],
    ["an empty command", [{ name: "x", run: "" }]],
    ["a key of nobody's", [{ name: "x", run: "y", shell: "bash" }]],
    ["a working directory that leaves the checkout", [{ name: "x", run: "y", workingDirectory: "../elsewhere" }]],
    ["an absolute working directory", [{ name: "x", run: "y", workingDirectory: "/tmp" }]],
    ["a string that is not a step", ["npm test"]],
  ];
  for (const [label, steps] of badSteps) {
    const errors = failures(t, (manifest) => (edgeNamed(manifest, "lab-to-hub").setupSteps = structuredClone(steps)));
    assert.ok(errors.some((error) => error.startsWith("schema-validation: ") && error.includes("setupSteps")), `${label}: ${errors.join(" | ")}`);
  }
});

test("the manifest-expression rule covers a setup step, because its command is written into a workflow", (t) => {
  const errors = failures(t, (manifest) => (edgeNamed(manifest, "lab-to-hub").setupSteps = [{ name: "x", run: "echo ${{ secrets.TOKEN }}" }]));
  assert.ok(errors.some((error) => error.startsWith("manifest-expression-opener: ") && error.includes("/setupSteps/0/run")), errors.join("\n"));
});
