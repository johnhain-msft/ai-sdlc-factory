// The router workflow as rendered by SPEC-01 and as the script depends on it (SPEC-03 AC1, AC2): the three triggers, the matrix, its serialisation and
// concurrency, the checkout and install that come before the script, and the environment that the step hands to src/route-upstream.mjs. The last cases
// check that the script reads nothing that the step does not provide, and that the installed engine's scripts import nothing missing from a sparse workspace.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import YAML from "yaml";
import { ROUTER_TIMEOUT_MINUTES } from "../../src/route-upstream.mjs";
import { presetManifest } from "../helpers/preset.mjs";
import { abs, presetEdges, readText } from "./helpers/fixtures.mjs";
import { installedSparseCopy, sparseCopy } from "./helpers/sparse.mjs";

const ROUTER_FILE = abs(".github", "workflows", "cascade-router.yml");
const routerText = readText(ROUTER_FILE);
const router = YAML.parse(routerText);
const manifestEdges = presetEdges();
const job = router.jobs.route;
const factory = presetManifest().factory;
const factoryDir = factory.dir ?? `node_modules/${factory.package}`;
const factorySource = factory.source.slice("github:".length);
const [factoryOwner, factoryRepo] = factorySource.split("/");

test("AC1 the router has exactly the three triggers: repository_dispatch for upstream_pr_merged, a schedule, and workflow_dispatch with reset_blocked", () => {
  assert.deepEqual(Object.keys(router.on).sort(), ["repository_dispatch", "schedule", "workflow_dispatch"]);
  assert.deepEqual(router.on.repository_dispatch.types, ["upstream_pr_merged"]);
  assert.equal(Array.isArray(router.on.schedule) && router.on.schedule.length >= 1, true);
  assert.deepEqual(Object.keys(router.on.workflow_dispatch.inputs), ["reset_blocked"]);
  assert.equal(router.on.workflow_dispatch.inputs.reset_blocked.type, "boolean");
});

test("AC1 the matrix job checks out without persisted credentials, mints a private factory read token, and installs before running the installed router", () => {
  const steps = job.steps;
  assert.equal(steps[0].uses, "actions/checkout@v4");
  assert.deepEqual(steps[0].with, { "persist-credentials": false });
  assert.deepEqual(steps[1], {
    name: "Mint the factory read token",
    id: "factory_token",
    uses: "actions/create-github-app-token@v2",
    with: { "app-id": "${{ vars.APP_CLIENT_ID }}", "private-key": "${{ secrets.APP_PRIVATE_KEY }}", owner: factoryOwner, repositories: factoryRepo, "permission-contents": "read" },
  });
  assert.equal(steps[2].name, "Install the factory");
  assert.equal(steps[2].run, "npm ci --ignore-scripts");
  const tokenUrl = `url.https://x-access-token:\${{ steps.factory_token.outputs.token }}@github.com/${factorySource}.insteadOf`;
  assert.deepEqual(steps[2].env, {
    GIT_TERMINAL_PROMPT: "0",
    GIT_CONFIG_COUNT: "3",
    GIT_CONFIG_KEY_0: tokenUrl,
    GIT_CONFIG_VALUE_0: `ssh://git@github.com/${factorySource}`,
    GIT_CONFIG_KEY_1: tokenUrl,
    GIT_CONFIG_VALUE_1: `git@github.com:${factorySource}`,
    GIT_CONFIG_KEY_2: tokenUrl,
    GIT_CONFIG_VALUE_2: `https://github.com/${factorySource}`,
  });
  const routing = steps.findIndex((step) => String(step.run ?? "").includes("src/route-upstream.mjs"));
  assert.equal(routing, 3, "the router step comes after the checkout, token and install");
  assert.equal(steps[routing].run, `node "$GITHUB_WORKSPACE/${factoryDir}/src/route-upstream.mjs"`);
  assert.equal(steps.length, 4, "and there is nothing else in the job");
});

test("AC2 one matrix job per dependencyEdges entry, serial, with fail-fast off and the state concurrency group of its upstream", () => {
  assert.deepEqual(job.strategy.matrix.upstreamKey, manifestEdges.map((entry) => entry.upstreamKey));
  assert.deepEqual(job.strategy.matrix.include.map((entry) => entry.upstreamKey), manifestEdges.map((entry) => entry.upstreamKey));
  assert.equal(job.strategy["max-parallel"], 1);
  assert.equal(job.strategy["fail-fast"], false);
  assert.deepEqual(job.concurrency, { group: "sdlc-state-${{ matrix.upstreamKey }}", "cancel-in-progress": false });
});

test("AC2 rg sdlc-state- finds only the matrix.upstreamKey group", () => {
  const lines = routerText.split("\n").filter((line) => line.includes("sdlc-state-"));
  assert.deepEqual(lines.map((line) => line.trim()), ["group: sdlc-state-${{ matrix.upstreamKey }}"]);
});

test("the matrix carries every edge's values for the script: the 21 keys of the edge, and nothing that the script has to look up elsewhere", () => {
  for (const [index, entry] of job.strategy.matrix.include.entries()) {
    const manifest = manifestEdges[index];
    // onBots is not an entry of sdlc.yaml: the reconciler derives it from the App of the request
    for (const key of ["edgeId", "upstreamRepo", "upstreamKey", "upstreamSlug", "upstreamDefaultBranch", "initialBaselineSha", "downstreamRepo", "mode", "schedule", "onCommitOnlyAdvance", "stateVariable", "provenanceFile", "provenanceJsonPointer", "branchName", "closeOlderKey", "reviewers", "importCommands", "preflightCommands", "buildCommands", "verifyCommands"]) {
      assert.deepEqual(entry[key], manifest[key], `${entry.upstreamKey}.${key}`);
    }
    assert.ok(Array.isArray(entry.onBots) && entry.onBots.every((bot) => typeof bot === "string"), `${entry.upstreamKey}.onBots`);
    assert.equal(Object.keys(entry).length, 21, entry.upstreamKey);
  }
});

test("the router step hands the script exactly the environment that it reads, and the job has the timeout that the script keeps its waits inside", () => {
  const step = job.steps.find((candidate) => String(candidate.run ?? "").includes("src/route-upstream.mjs"));
  assert.deepEqual(step.env, {
    UPSTREAM_KEY: "${{ matrix.upstreamKey }}",
    EDGE_JSON: "${{ toJSON(matrix) }}",
    EVENT_NAME: "${{ github.event_name }}",
    CLIENT_PAYLOAD: "${{ toJSON(github.event.client_payload) }}",
    RESET_BLOCKED: "${{ inputs.reset_blocked }}",
    APP_CLIENT_ID: "${{ vars.APP_CLIENT_ID }}",
    APP_PRIVATE_KEY: "${{ secrets.APP_PRIVATE_KEY }}",
    ISSUES_TOKEN: "${{ secrets.GITHUB_TOKEN }}",
  });
  assert.equal(job["timeout-minutes"], ROUTER_TIMEOUT_MINUTES);
  assert.deepEqual(router.permissions, { contents: "read", issues: "write" }, "the token of the job can read the repository and write the failure issue, nothing else");
});

test("the script reads no environment variable that the step does not hand it or the runner does not provide", () => {
  const provided = new Set(["UPSTREAM_KEY", "EDGE_JSON", "EVENT_NAME", "CLIENT_PAYLOAD", "RESET_BLOCKED", "APP_CLIENT_ID", "APP_PRIVATE_KEY", "ISSUES_TOKEN"]);
  const runner = new Set(["GITHUB_REPOSITORY", "GITHUB_WORKSPACE", "GITHUB_STEP_SUMMARY", "GITHUB_RUN_ID", "GITHUB_RUN_ATTEMPT", "GITHUB_SERVER_URL", "GITHUB_API_URL", "RUNNER_TEMP", "GITHUB_ACTIONS", "PATH", "Path"]);
  const files = [abs("src", "route-upstream.mjs"), ...fs.readdirSync(abs("src", "routing")).map((name) => abs("src", "routing", name))];
  const read = new Set();
  for (const file of files) for (const match of readText(file).matchAll(/\b(?:env|environment)\.([A-Z][A-Z0-9_]+)\b/g)) read.add(match[1]);
  for (const name of read) assert.ok(provided.has(name) || runner.has(name), `${name} is read by the router but is neither in the step nor provided by the runner`);
  for (const name of provided) assert.ok(read.has(name), `${name} is handed to the script but never read`);
});

test("AC31 the router and the mechanical workflow call no reusable workflow: no workflow_call and no local workflow reference, in the sources and in the compiled lock; the routing logic is in scripts run by run: steps", () => {
  const files = [".github/workflows/cascade-router.yml", ...manifestEdges.filter((entry) => entry.mode === "mechanical").flatMap((entry) => [`.github/workflows/cascade-mechanical-${entry.edgeId}.md`, `.github/workflows/cascade-mechanical-${entry.edgeId}.lock.yml`])];
  for (const file of files) {
    const text = readText(abs(...file.split("/")));
    assert.equal(/workflow_call/.test(text), false, `${file} has workflow_call`);
    assert.equal(/uses:\s*\.\/\.github\/workflows/.test(text), false, `${file} calls a local reusable workflow`);
  }
  for (const step of job.steps) assert.equal(typeof step.uses === "string" && step.uses.includes(".github/workflows"), false);
  assert.ok(job.steps.some((step) => String(step.run ?? "").includes("src/route-upstream.mjs")), "the routing is a script run by a run: step");
});

test("the scripts import successfully from sparse installed-engine and workspace-engine layouts without bin or tests", (t) => {
  for (const installed of [false, true]) {
    const copy = installed ? installedSparseCopy(factoryDir) : sparseCopy();
    t.after(() => copy.cleanup());
    for (const script of ["update-poll-state.mjs", "route-upstream.mjs"]) {
      const result = spawnSync(process.execPath, [path.join(copy.engineDir, "src", script)], { cwd: copy.dir, encoding: "utf8", timeout: 120000, env: copy.environment() });
      assert.equal(result.status, 2, `${script} (installed=${installed}): ${result.stderr}`);
      assert.equal(/ERR_MODULE_NOT_FOUND|Cannot find module|ENOENT/.test(result.stderr), false, `${script} imports something that the sparse checkout does not contain: ${result.stderr}`);
      assert.match(result.stderr, script === "route-upstream.mjs" ? /GITHUB_REPOSITORY must be/ : /--slug is required|GITHUB_REPOSITORY|--record-failure/);
    }
    assert.equal(fs.existsSync(path.join(copy.dir, "bin")), false);
    assert.equal(fs.existsSync(path.join(copy.dir, "tests")), false);
    assert.equal(fs.existsSync(path.join(copy.dir, "src")), !installed);
    assert.equal(fs.existsSync(path.join(copy.engineDir, "schemas", "sdlc-routing.schema.json")), true);
  }
});
