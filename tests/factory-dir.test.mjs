// The factory block of the manifest (design sections B and C): where the factory package runs from in the orchestrator workspace, and how the jobs that
// need it install it. No block means the engine is in the workspace itself, and the render is the one this renderer always made.

import assert from "node:assert/strict";
import test from "node:test";
import YAML from "yaml";
import { bodyOf, frontmatterOf, named, routerOf, routerSteps, stepsOf, workflowsOf } from "./helpers/rendered.mjs";
import { checkRendered, renderFleet } from "../src/reconcile.mjs";
import { createWorkspace, miniManifest, referenceRequest } from "./helpers/mini-fleet.mjs";

const FACTORY = { package: "ai-sdlc-factory", source: "github:example-org/ai-sdlc-factory", private: true };
const withFactory = (block = FACTORY, then = () => {}) => (manifest) => {
  if (block !== null) manifest.factory = structuredClone(block);
  then(manifest);
};
const PKG = "$GITHUB_WORKSPACE/node_modules/ai-sdlc-factory";
const PACKAGE_JSON = JSON.stringify({ name: "example-orchestrator", private: true, dependencies: { "ai-sdlc-factory": "github:example-org/ai-sdlc-factory#v0.1.0" } });

function render(t, { mutate, manifestPath, files } = {}) {
  const work = createWorkspace(t, { mutate, manifestPath, files });
  const result = renderFleet(referenceRequest({ manifestPath: manifestPath ?? "sdlc.yaml" }), { cwd: work.dir });
  assert.equal(result.ok, true, JSON.stringify(result.result));
  return { work, files: result.files };
}

function failures(t, mutate, files) {
  const work = createWorkspace(t, { mutate, files });
  const result = renderFleet(referenceRequest(), { cwd: work.dir });
  assert.equal(result.ok, false, "the render was expected to be refused");
  return result.result.validationResults.flatMap((entry) => entry.errors);
}

// ---- what the install block is ------------------------------------------------------------------------------------------------------------------

const REWRITE_KEY = "url.https://x-access-token:${{ steps.factory_token.outputs.token }}@github.com/example-org/ai-sdlc-factory.insteadOf";
const TOKEN_STEP = {
  name: "Mint the factory read token",
  id: "factory_token",
  uses: "actions/create-github-app-token@v2",
  with: {
    "app-id": "${{ vars.APP_CLIENT_ID }}",
    "private-key": "${{ secrets.APP_PRIVATE_KEY }}",
    owner: "example-org",
    repositories: "ai-sdlc-factory",
    "permission-contents": "read",
  },
};
const INSTALL_PRIVATE = {
  name: "Install the factory",
  env: {
    GIT_TERMINAL_PROMPT: "0",
    GIT_CONFIG_COUNT: "3",
    GIT_CONFIG_KEY_0: REWRITE_KEY,
    GIT_CONFIG_VALUE_0: "ssh://git@github.com/example-org/ai-sdlc-factory",
    GIT_CONFIG_KEY_1: REWRITE_KEY,
    GIT_CONFIG_VALUE_1: "git@github.com:example-org/ai-sdlc-factory",
    GIT_CONFIG_KEY_2: REWRITE_KEY,
    GIT_CONFIG_VALUE_2: "https://github.com/example-org/ai-sdlc-factory",
  },
  run: "npm ci --ignore-scripts",
};
const INSTALL_PUBLIC = { run: "npm ci --ignore-scripts" };
const SPARSE_FACTORY = { "sparse-checkout": "/package.json\n/package-lock.json\n/sdlc.yaml", "sparse-checkout-cone-mode": false, "persist-credentials": false };

const sameSteps = (actual, expected, label) => {
  assert.deepEqual(actual, expected, label);
  assert.deepEqual(actual.map((step) => Object.keys(step)), expected.map((step) => Object.keys(step)), `${label}: key order`);
};

// ---- no factory block: the engine is in the workspace ----------------------------------------------------------------------------------------

test("no factory block: every script runs from $GITHUB_WORKSPACE/src, the custom jobs keep their sparse src and schemas checkout and their plain npm ci", (t) => {
  const { files } = render(t);
  for (const workflow of workflowsOf(files)) {
    assert.doesNotMatch(workflow.text, /node_modules\/ai-sdlc-factory/, workflow.file);
    assert.doesNotMatch(workflow.text, /factory_token|GIT_CONFIG/, workflow.file);
    for (const [name, job] of Object.entries(workflow.fm.jobs ?? {})) {
      if (!job.steps) continue;
      const checkout = job.steps.find((step) => step.uses === "actions/checkout@v4");
      if (checkout === undefined) continue;
      assert.equal(checkout.with["sparse-checkout"], "src\nschemas", `${workflow.id} ${name}`);
      assert.equal("sparse-checkout-cone-mode" in checkout.with, false);
      assert.deepEqual(job.steps.filter((step) => step.run === "npm ci --ignore-scripts"), [INSTALL_PUBLIC], `${workflow.id} ${name}`);
    }
    if (workflow.fm["pre-agent-steps"]) assert.equal(JSON.stringify(workflow.fm["pre-agent-steps"]).includes("npm ci --ignore-scripts"), false, `${workflow.id}: no engine install in an agent job`);
  }
  const router = routerOf(files);
  assert.deepEqual(router.jobs.route.steps.slice(0, 2), [{ uses: "actions/checkout@v4", with: { "persist-credentials": false } }, INSTALL_PUBLIC]);
  assert.match(files.get(".github/workflows/drift-docs-site.md"), /node "\$GITHUB_WORKSPACE\/src\/drift\/prepare-run\.mjs"/);
  assert.match(files.get(".github/workflows/cascade-router.yml"), /node "\$GITHUB_WORKSPACE\/src\/route-upstream\.mjs"/);
  assert.match(bodyOf(files.get(".github/workflows/sdlc-onboard.md")), /Run `node bin\/sdlc-onboard\.mjs --repo/);
});

test("an explicit dir of . is the same render as no block at all", (t) => {
  const none = render(t);
  const dot = render(t, { mutate: withFactory({ package: "ai-sdlc-factory", dir: "." }) });
  for (const [file, text] of none.files) assert.equal(dot.files.get(file), text, file);
  assert.deepEqual([...dot.files.keys()], [...none.files.keys()]);
});

// ---- a factory block: where every script runs from ---------------------------------------------------------------------------------------------

const SCRIPTS = {
  "drift-docs-site": ["drift/prepare-run", "drift/dedupe-open-prs", "drift/previous-watch-index", "snapshot-watch-sources", "drift/escalate-gate-failure"],
  "drift-lab-content": ["drift/prepare-run", "drift/dedupe-open-prs", "drift/previous-watch-index", "snapshot-watch-sources", "drift/escalate-gate-failure"],
  "implement-docs-site": ["drift/prepare-run", "drift/read-report", "drift/dedupe-open-prs", "drift/escalate-gate-failure"],
  "implement-lab-content": ["drift/prepare-run", "drift/read-report", "drift/dedupe-open-prs", "drift/escalate-gate-failure"],
  "cascade-mechanical-docs-to-hub": ["update-poll-state"],
  "cascade-ai-lab-to-hub": ["verify-immutable-gates", "update-poll-state", "ai-pull-request-result"],
  "sdlc-onboard": [],
};

test("with a factory block every engine script of every workflow, and the router, runs from the factory directory", (t) => {
  const { files } = render(t, { mutate: withFactory(FACTORY), files: { "package.json": PACKAGE_JSON } });
  for (const workflow of workflowsOf(files)) {
    assert.doesNotMatch(workflow.text, /\$GITHUB_WORKSPACE\/src\//, `${workflow.id} still runs a script from $GITHUB_WORKSPACE/src`);
    const used = [...workflow.text.matchAll(/"\$GITHUB_WORKSPACE\/node_modules\/ai-sdlc-factory\/src\/([a-z/-]+)\.mjs"/g)].map((match) => match[1]);
    assert.deepEqual([...new Set(used)].sort(), [...SCRIPTS[workflow.id]].sort(), workflow.id);
  }
  const router = files.get(".github/workflows/cascade-router.yml");
  assert.match(router, /run: node "\$GITHUB_WORKSPACE\/node_modules\/ai-sdlc-factory\/src\/route-upstream\.mjs"/);
  assert.doesNotMatch(router, /\$GITHUB_WORKSPACE\/src\//);
  // the verification gate of an AI cascade is both a step name and its command
  const ai = frontmatterOf(files.get(".github/workflows/cascade-ai-lab-to-hub.md"));
  const gate = ai["post-steps"].find((step) => String(step.run).includes("verify-immutable-gates.mjs"));
  assert.equal(gate.name, gate.run);
  assert.ok(gate.run.startsWith(`node --frozen-intrinsics "${PKG}/src/verify-immutable-gates.mjs" `), gate.run);
});

test("another dir moves every script there, and a dir under the workspace needs no node_modules", (t) => {
  const { files } = render(t, { mutate: withFactory({ package: "ai-sdlc-factory", dir: "vendor/factory", private: false }) });
  assert.match(files.get(".github/workflows/drift-docs-site.md"), /node "\$GITHUB_WORKSPACE\/vendor\/factory\/src\/drift\/prepare-run\.mjs"/);
  assert.doesNotMatch(files.get(".github/workflows/drift-docs-site.md"), /node_modules\/ai-sdlc-factory/);
  const normalized = render(t, { mutate: withFactory({ package: "ai-sdlc-factory", dir: "./vendor//factory/", private: false }) });
  for (const [file, text] of files) assert.equal(normalized.files.get(file), text, `${file}: ./vendor//factory/ is vendor/factory`);
});

test("the onboarding prompt names the onboarding command inside the factory directory", (t) => {
  const { files } = render(t, { mutate: withFactory(FACTORY) });
  assert.match(bodyOf(files.get(".github/workflows/sdlc-onboard.md")), /Run `node node_modules\/ai-sdlc-factory\/bin\/sdlc-onboard\.mjs --repo <repo>`/);
});

// ---- the sparse checkouts and the install block ------------------------------------------------------------------------------------------------

test("private: the custom jobs check out three files, mint the factory token and install with the git rewrites in the step's own environment", (t) => {
  const { files } = render(t, { mutate: withFactory(FACTORY) });
  for (const workflow of workflowsOf(files)) {
    if (workflow.id === "sdlc-onboard") continue;
    const escalation = workflow.fm.jobs.escalate_failure.steps;
    const cascade = workflow.id.startsWith("cascade-");
    if (cascade) {
      assert.equal(escalation[0].id, "app_token", `${workflow.id}: the poll-state token comes first`);
      sameSteps(escalation.slice(1, 4), [{ uses: "actions/checkout@v4", with: { token: "${{ steps.app_token.outputs.token }}", ...SPARSE_FACTORY } }, TOKEN_STEP, INSTALL_PRIVATE], `${workflow.id} escalate_failure`);
      const finalize = workflow.fm.jobs.finalize_poll_state.steps;
      sameSteps(finalize.slice(1, 4), [{ uses: "actions/checkout@v4", with: { token: "${{ steps.app_token.outputs.token }}", ...SPARSE_FACTORY } }, TOKEN_STEP, INSTALL_PRIVATE], `${workflow.id} finalize_poll_state`);
    } else {
      sameSteps(escalation.slice(0, 3), [{ uses: "actions/checkout@v4", with: SPARSE_FACTORY }, TOKEN_STEP, INSTALL_PRIVATE], `${workflow.id} escalate_failure`);
    }
  }
  const route = routerOf(files).jobs.route.steps;
  sameSteps(route.slice(0, 3), [{ uses: "actions/checkout@v4", with: { "persist-credentials": false } }, TOKEN_STEP, INSTALL_PRIVATE], "the router checks out everything, then installs");
});

test("private: every factory token follows the declared source owner and repository", (t) => {
  const { files } = render(t, { mutate: withFactory({ ...FACTORY, source: "github:another-org/factory-engine" }) });
  const steps = [...workflowsOf(files).flatMap(({ fm }) => stepsOf(fm)), ...routerSteps(routerOf(files))];
  const tokens = steps.filter(({ step }) => step.id === "factory_token");
  assert.equal(tokens.length, 14);
  for (const { where, step } of tokens) {
    assert.equal(step.with.owner, "another-org", where);
    assert.equal(step.with.repositories, "factory-engine", where);
  }
});

test("private: the sparse checkout names the manifest where the request puts it", (t) => {
  const { files } = render(t, { manifestPath: "config/fleet.yaml", mutate: withFactory(FACTORY) });
  const ai = frontmatterOf(files.get(".github/workflows/cascade-ai-lab-to-hub.md"));
  assert.equal(ai.jobs.finalize_poll_state.steps[1].with["sparse-checkout"], "/package.json\n/package-lock.json\n/config/fleet.yaml");
  const drift = frontmatterOf(files.get(".github/workflows/drift-docs-site.md"));
  assert.equal(drift.jobs.escalate_failure.steps[0].with["sparse-checkout"], "/package.json\n/package-lock.json\n/config/fleet.yaml");
});

test("private: the agent jobs that run an engine script install it first, and the mechanical cascade, which runs none, does not", (t) => {
  const { files } = render(t, { mutate: withFactory(FACTORY) });
  for (const workflow of workflowsOf(files)) {
    const pre = workflow.fm["pre-agent-steps"] ?? [];
    if (/^(drift|implement)-/.test(workflow.id) || workflow.id === "cascade-ai-lab-to-hub") {
      sameSteps(pre.slice(0, 2), [TOKEN_STEP, INSTALL_PRIVATE], `${workflow.id} pre-agent-steps`);
      assert.equal(pre.filter((step) => step.id === "factory_token").length, 1);
    } else {
      assert.equal(JSON.stringify(pre).includes("factory_token"), false, `${workflow.id} installs nothing in its agent job`);
      assert.equal(JSON.stringify(pre).includes("npm ci"), false, workflow.id);
    }
  }
});

test("a mechanical cascade whose commands name <factory> installs it in the agent job as well", (t) => {
  const { files } = render(t, {
    mutate: withFactory(FACTORY, (manifest) => {
      manifest.dependencyEdges[0].verifyCommands = ["node <factory>/bin/check.mjs <factory-dir>"];
    }),
  });
  const mechanical = frontmatterOf(files.get(".github/workflows/cascade-mechanical-docs-to-hub.md"));
  sameSteps(mechanical["pre-agent-steps"].slice(0, 2), [TOKEN_STEP, INSTALL_PRIVATE], "the install block comes first");
  const check = mechanical["post-steps"].find((step) => String(step.run).includes("check.mjs"));
  assert.equal(check.run, `node "${PKG}"/bin/check.mjs node_modules/ai-sdlc-factory`);
  // without the factory block the same placeholders point at the workspace itself
  const legacy = render(t, {
    mutate: (manifest) => {
      manifest.dependencyEdges[0].verifyCommands = ["node <factory>/bin/check.mjs <factory-dir>"];
    },
  });
  const plain = frontmatterOf(legacy.files.get(".github/workflows/cascade-mechanical-docs-to-hub.md"));
  assert.equal(plain["post-steps"].find((step) => String(step.run).includes("check.mjs")).run, 'node "$GITHUB_WORKSPACE"/bin/check.mjs .');
  assert.equal(JSON.stringify(plain["pre-agent-steps"]).includes("npm ci"), false);
});

test("public: the token step and the rewrites go, the install step is the plain npm ci, and nothing else moves", (t) => {
  const priv = render(t, { mutate: withFactory(FACTORY) });
  const pub = render(t, { mutate: withFactory({ ...FACTORY, private: false }) });
  const route = routerOf(pub.files).jobs.route.steps;
  sameSteps(route.slice(0, 2), [{ uses: "actions/checkout@v4", with: { "persist-credentials": false } }, INSTALL_PUBLIC], "router");
  for (const workflow of workflowsOf(pub.files)) {
    if (/^(drift|implement)-/.test(workflow.id) || workflow.id === "cascade-ai-lab-to-hub") assert.deepEqual(workflow.fm["pre-agent-steps"][0], INSTALL_PUBLIC, workflow.id);
  }
  // the private render, without the token steps and with the install steps reduced to the plain one, is the public render
  const strip = (steps) => steps.filter((step) => step.id !== "factory_token").map((step) => (step.name === "Install the factory" ? INSTALL_PUBLIC : step));
  for (const workflow of workflowsOf(priv.files)) {
    const expected = structuredClone(workflow.fm);
    for (const key of ["pre-agent-steps"]) if (expected[key]) expected[key] = strip(expected[key]);
    for (const job of Object.values(expected.jobs ?? {})) if (job.steps) job.steps = strip(job.steps);
    const other = frontmatterOf(pub.files.get(workflow.file));
    assert.deepEqual(other, expected, `${workflow.id}: public is private minus the auth`);
    assert.equal(bodyOf(pub.files.get(workflow.file)), bodyOf(workflow.text), `${workflow.id}: the prompt does not change`);
  }
  const privateRouter = routerOf(priv.files);
  privateRouter.jobs.route.steps = strip(privateRouter.jobs.route.steps);
  assert.deepEqual(routerOf(pub.files), privateRouter);
});

// ---- the checks of the rendered output ---------------------------------------------------------------------------------------------------------

test("checkRendered accepts the factory token step in a job that writes the poll state, and still demands variables: write of the poll-state token", (t) => {
  const { files } = render(t, { mutate: withFactory(FACTORY) });
  const request = referenceRequest();
  const manifest = YAML.parse(YAML.stringify(miniManifest()));
  const results = checkRendered(files, request, manifest);
  assert.deepEqual(results.filter((entry) => !entry.valid), []);

  // the same step under another id is an ordinary token step with explicit permissions that lack variables: write
  const file = ".github/workflows/cascade-ai-lab-to-hub.md";
  const fm = frontmatterOf(files.get(file));
  named(fm.jobs.finalize_poll_state.steps, "Mint the factory read token").id = "other_token";
  const mutated = new Map(files).set(file, `---\n${YAML.stringify(fm, { lineWidth: 0 })}---\n\n${bodyOf(files.get(file))}\n`);
  const flagged = checkRendered(mutated, request, manifest).filter((entry) => !entry.valid);
  assert.equal(flagged.length, 1);
  assert.equal(flagged[0].file, file);
  assert.match(flagged[0].errors.join("\n"), /app-token-permission-missing: .*finalize_poll_state.*variables: write/);
});

// ---- the rules -------------------------------------------------------------------------------------------------------------------------------

test("factory-token-shape: checkRendered refuses a factory token step that could reach more than the factory repository, or more than read it", (t) => {
  const { files } = render(t, { mutate: withFactory(FACTORY) });
  const request = referenceRequest();
  const manifest = YAML.parse(YAML.stringify(miniManifest()));
  const mutateStep = (mutate) => {
    const file = ".github/workflows/drift-docs-site.md";
    const fm = frontmatterOf(files.get(file));
    mutate(named(fm["pre-agent-steps"], "Mint the factory read token"));
    return { file, files: new Map(files).set(file, `---\n${YAML.stringify(fm, { lineWidth: 0 })}---\n\n${bodyOf(files.get(file))}\n`) };
  };
  for (const [label, mutate, pattern] of [
    ["no repositories", (step) => delete step.with.repositories, /names no repositories/],
    ["empty repositories", (step) => (step.with.repositories = " "), /names no repositories/],
    ["a second permission", (step) => (step.with["permission-issues"] = "write"), /permission-contents: read and no other permission/],
    ["write access", (step) => (step.with["permission-contents"] = "write"), /permission-contents: read and no other permission/],
    ["no permission", (step) => delete step.with["permission-contents"], /permission-contents: read and no other permission/],
    ["no revocation", (step) => (step.with["skip-token-revoke"] = true), /skip-token-revoke/],
    ["not the token action", (step) => (step.uses = "actions/checkout@v4"), /is not an actions\/create-github-app-token step/],
  ]) {
    const { file, files: mutated } = mutateStep(mutate);
    const flagged = checkRendered(mutated, request, manifest).filter((entry) => !entry.valid);
    assert.deepEqual(flagged.map((entry) => entry.file), [file], label);
    assert.match(flagged[0].errors.join("\n"), new RegExp(`^factory-token-shape: ${file.replace(/\./g, "\\.")} `), label);
    assert.match(flagged[0].errors.join("\n"), pattern, label);
  }
  // the router is checked the same way
  const router = routerOf(files);
  delete named(router.jobs.route.steps, "Mint the factory read token").with.repositories;
  const flaggedRouter = checkRendered(new Map(files).set(".github/workflows/cascade-router.yml", `# Generated by src/reconcile.mjs from the fleet manifest. Do not edit.\n${YAML.stringify(router, { lineWidth: 0 })}`), request, manifest).filter((entry) => !entry.valid);
  assert.match(flaggedRouter.flatMap((entry) => entry.errors).join("\n"), /factory-token-shape: .*cascade-router\.yml .*names no repositories/);
});

test("factory-source-required: a private factory names the repository that the token is minted for", (t) => {
  const errors = failures(t, withFactory({ package: "ai-sdlc-factory", private: true }));
  assert.ok(errors.some((error) => error.startsWith("factory-source-required: ")), errors.join("\n"));
  // a public factory needs no source
  render(t, { mutate: withFactory({ package: "ai-sdlc-factory", private: false }) });
  render(t, { mutate: withFactory({ package: "ai-sdlc-factory" }) });
});

test("factory-dir-invalid: dir is a plain repository-relative path, because it is interpolated into shell text", (t) => {
  for (const dir of ["/abs/factory", "../factory", "a/../b", "a b", "a;b", "a$(x)", "-factory", "a\\b", "a'b", `${"a".repeat(201)}`]) {
    const errors = failures(t, withFactory({ ...FACTORY, dir }));
    assert.ok(errors.some((error) => error.startsWith("factory-dir-invalid: ")), `${JSON.stringify(dir)}: ${errors.join(" | ")}`);
  }
  for (const dir of [".", "vendor/factory", "node_modules/@scope/pkg", "./vendor/factory", "vendor/factory/"]) {
    render(t, { mutate: withFactory({ ...FACTORY, private: false, dir }) });
  }
});

test("factory-dir-invalid also refuses a private factory that lives in the workspace itself", (t) => {
  const errors = failures(t, withFactory({ ...FACTORY, dir: "." }));
  assert.ok(errors.some((error) => error.startsWith("factory-dir-invalid: ") && error.includes("private")), errors.join("\n"));
});

test("factory-dependency-missing: the workspace package.json has to depend on the package whose install is rendered", (t) => {
  const other = JSON.stringify({ name: "example-orchestrator", dependencies: { "something-else": "1.0.0" } });
  const errors = failures(t, withFactory(FACTORY), { "package.json": other });
  assert.ok(errors.some((error) => error.startsWith("factory-dependency-missing: ") && error.includes("ai-sdlc-factory")), errors.join("\n"));
  render(t, { mutate: withFactory(FACTORY), files: { "package.json": PACKAGE_JSON } });
  render(t, { mutate: withFactory(FACTORY), files: { "package.json": JSON.stringify({ devDependencies: { "ai-sdlc-factory": "1.0.0" } }) } });
  // no package.json: nothing to compare with; an in-workspace factory needs no dependency
  render(t, { mutate: withFactory(FACTORY) });
  render(t, { mutate: withFactory({ package: "ai-sdlc-factory", dir: "." }), files: { "package.json": other } });
});

test("the manifest-expression rule and the schema cover the factory block", (t) => {
  const opener = failures(t, withFactory({ package: "ai-sdlc-factory", dir: "${{ github.workspace }}", private: false }));
  assert.ok(opener.some((error) => error.startsWith("manifest-expression-opener: ") && error.includes("/factory/dir")), opener.join("\n"));
  for (const block of [{ source: "github:example-org/ai-sdlc-factory" }, { package: "Not A Package" }, { package: "ai-sdlc-factory", source: "example-org/ai-sdlc-factory" }, { package: "ai-sdlc-factory", source: "github:example-org/ai-sdlc-factory#v1" }, { package: "ai-sdlc-factory", private: "yes" }, { package: "ai-sdlc-factory", extra: true }]) {
    const errors = failures(t, withFactory(block));
    assert.ok(errors.some((error) => error.startsWith("schema-validation: ") && error.includes("/factory")), `${JSON.stringify(block)}: ${errors.join(" | ")}`);
  }
});
