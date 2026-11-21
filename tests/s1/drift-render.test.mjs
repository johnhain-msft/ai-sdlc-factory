// AC20, AC22, AC23, AC25 and AC27: the drift workflow of contract C2.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { renderFleet } from "../../src/reconcile.mjs";
import {
  abs,
  customJobsOf,
  minimalManifest,
  mutate,
  parseWorkflow,
  PRESET_ROOT,
  presetManifest,
  projectOf,
  readText,
  readWorkflow,
  referenceRequest,
  toYaml,
  withRequest,
} from "./helpers/fixtures.mjs";
import { FACTORY_DIR, FACTORY_INSTALL, FACTORY_PATH, FACTORY_SPARSE, FACTORY_TOKEN, fillCommand } from "./helpers/factory.mjs";
import { CHANGE_POLICIES, renderMinimal, renderPolicy } from "./helpers/policy.mjs";
import { createWorkspace } from "./helpers/workspace.mjs";

const W = ".github/workflows";
const request = referenceRequest();
const preset = presetManifest();
const DRIFT_KEYS = preset.projects.filter((project) => project.driftAudit.enabled).map((project) => project.projectKey);
const APP = { "client-id": "${{ vars.APP_CLIENT_ID }}", "private-key": "${{ secrets.APP_PRIVATE_KEY }}" };

const rendered = renderFleet(request, { cwd: PRESET_ROOT });
assert.ok(rendered.ok, JSON.stringify(rendered.result));
const generated = (key) => parseWorkflow(rendered.files.get(`${W}/drift-${key}.md`));
const trackedFiles = (pathspec) =>
  spawnSync("git", ["ls-files", pathspec], { cwd: PRESET_ROOT, encoding: "utf8" }).stdout.split("\n").filter((line) => line !== "");

test("AC20: the generated drift set equals the enabled set for the preset", () => {
  const set = rendered.workflows.filter((workflow) => workflow.kind === "drift").map((workflow) => workflow.id);
  assert.deepEqual(set, DRIFT_KEYS.map((key) => `drift-${key}`).sort());
  const enabled = preset.projects.filter((project) => project.driftAudit.enabled).map((project) => `drift-${project.projectKey}`);
  assert.deepEqual([...set].sort(), [...enabled].sort());
  const files = [...rendered.files.keys()].filter((file) => /\/drift-[^/]+\.md$/.test(file));
  assert.deepEqual(files, DRIFT_KEYS.map((key) => `${W}/drift-${key}.md`).sort());
});

test("AC20: with one project disabled its workflow disappears; enabling a project adds exactly one", () => {
  const disabled = mutate(preset, (copy) => (projectOf(copy, "agent-kit").driftAudit.enabled = false));
  const workspace = createWorkspace({ manifestText: toYaml(disabled), instructions: true });
  try {
    const result = renderFleet(request, { cwd: workspace.dir });
    assert.ok(result.ok);
    assert.deepEqual(result.workflows.filter((workflow) => workflow.kind === "drift").map((workflow) => workflow.id), DRIFT_KEYS.filter((key) => key !== "agent-kit").map((key) => `drift-${key}`).sort());
    assert.equal(result.files.has(`${W}/drift-agent-kit.md`), false);
  } finally {
    workspace.cleanup();
  }
  const minimal = createWorkspace({ manifestText: toYaml(minimalManifest()) });
  try {
    const result = renderFleet(request, { cwd: minimal.dir });
    assert.deepEqual(result.workflows.filter((workflow) => workflow.kind === "drift").map((workflow) => workflow.id), ["drift-alpha-service"]);
  } finally {
    minimal.cleanup();
  }
});

test("AC20: git ls-files lists exactly the six preset drift paths", () => {
  const expected = DRIFT_KEYS.flatMap((key) => [`${W}/drift-${key}.lock.yml`, `${W}/drift-${key}.md`]).sort();
  assert.deepEqual(trackedFiles(`${W}/drift-*`), expected);
});

/** The job that starts the implementation of the report that a run filed (SPEC-02 AC46). */
const implementReportJob = (key) => ({
  needs: ["safe_outputs"],
  if: "needs.safe_outputs.result == 'success' && needs.safe_outputs.outputs.created_issue_number != '' && inputs.dry_run != true",
  permissions: { actions: "write" },
  steps: [
    {
      name: "Start the implementation of the drift report",
      env: {
        GH_TOKEN: "${{ github.token }}",
        WORKFLOW_FILE: `implement-${key}.lock.yml`,
        REPORT_ISSUE: "${{ needs.safe_outputs.outputs.created_issue_number }}",
        CORRELATION_ID: "${{ inputs.correlation_id || format('run-{0}-{1}', github.run_id, github.run_attempt) }}",
      },
      run: 'gh workflow run "$WORKFLOW_FILE" --repo "$GITHUB_REPOSITORY" --ref "$GITHUB_REF_NAME" -f report_issue="$REPORT_ISSUE" -f correlation_id="$CORRELATION_ID"',
    },
  ],
});

function assertContract(frontmatter, project) {
  const audit = project.driftAudit;
  const repoName = project.repo.split("/")[1];
  assert.deepEqual(Object.keys(frontmatter).sort(), [
    "checkout", "concurrency", "engine", "jobs", "mcp-servers", "network", "on", "permissions", "post-steps", "pre-agent-steps", "safe-outputs", "tools",
  ]);
  assert.deepEqual(Object.keys(frontmatter.on).sort(), ["bots", "schedule", "workflow_dispatch"]);
  assert.deepEqual(frontmatter.on.schedule, [{ cron: audit.schedule }]);
  assert.deepEqual(frontmatter.on.bots, [`${request.appSlug}[bot]`]);
  assert.deepEqual(Object.keys(frontmatter.on.workflow_dispatch), ["inputs"]);
  const inputs = frontmatter.on.workflow_dispatch.inputs;
  assert.deepEqual(Object.keys(inputs).sort(), ["correlation_id", "dry_run", "extra_instructions", "target_repo"]);
  for (const name of ["target_repo", "correlation_id", "extra_instructions"]) assert.equal(inputs[name].type, "string", name);
  assert.equal(inputs.dry_run.type, "boolean");
  assert.deepEqual(frontmatter.concurrency, { group: `sdlc-drift-${project.projectKey}`, "cancel-in-progress": false });
  assert.deepEqual(frontmatter.permissions, { actions: "read", contents: "read", issues: "read", "pull-requests": "read" }, "actions: read lets the job find the previous run's watch index (SPEC-02 AC41)");
  assert.deepEqual(Object.keys(frontmatter.network), ["allowed"]);
  assert.ok(Array.isArray(frontmatter.network.allowed) && frontmatter.network.allowed.every((host) => typeof host === "string"));
  assert.deepEqual(frontmatter.checkout, [{ repository: project.repo, path: repoName, current: true, "github-app": { ...APP, repositories: [repoName] } }]);
  assert.deepEqual(frontmatter["mcp-servers"], audit.knowledgeSources.mcpServers);
  assert.ok(Array.isArray(frontmatter["pre-agent-steps"]) && Array.isArray(frontmatter["post-steps"]));
  const outputs = frontmatter["safe-outputs"];
  assert.deepEqual(Object.keys(outputs).sort(), ["create-issue", "create-pull-request", "github-app", "report-failure-as-issue", "threat-detection"]);
  assert.deepEqual(outputs["create-issue"], {
    "target-repo": project.repo,
    "title-prefix": "[sdlc-drift] ",
    labels: ["automated", "sdlc-drift", "drift-report"],
    "close-older-issues": false,
    max: 1,
  }, "at most one drift report per run, in the target repository, and no report closes an earlier one (SPEC-02 AC44)");
  assert.equal("noop" in outputs, false, "no explicit noop: an opt-in would make the compiler expect a maintenance workflow that the fleet does not keep");
  assert.deepEqual(outputs["github-app"], { ...APP, repositories: [repoName] }, "the token of the safe outputs reaches the target repository alone: its owner is the target's, so the central repository's name would be a 404 for another owner (AC69)");
  assert.equal(outputs["report-failure-as-issue"], false);
  assert.deepEqual(outputs["threat-detection"], { "continue-on-error": false });
  const handler = outputs["create-pull-request"];
  assert.deepEqual(Object.keys(handler).sort(), [
    "auto-merge", "branch-prefix", "close-older-key", "close-older-pull-requests", "draft", "exclude-lock-yml", "fallback-as-issue", "if-no-changes", "labels", "max",
    "max-patch-size", "preserve-branch-name", "protected-files", "recreate-ref", "reviewers", "target-repo", "title-prefix",
  ]);
  assert.equal(handler["target-repo"], project.repo);
  assert.equal(typeof handler["title-prefix"], "string");
  assert.ok(handler["title-prefix"].length > 0);
  assert.ok(Array.isArray(handler.labels) && handler.labels.length > 0 && handler.labels.every((label) => typeof label === "string"));
  assert.deepEqual(handler.reviewers, audit.reviewers);
  assert.equal(handler.draft, audit.draft);
  assert.equal(handler["branch-prefix"], "sdlc/");
  assert.equal(handler["preserve-branch-name"], true);
  assert.equal(handler["recreate-ref"], false, "a second run of the same day does not force-push the branch of an open pull request, which would close it (SPEC-02 AC25)");
  assert.equal(handler["if-no-changes"], "error", "a call with nothing committed fails the run, so the items that only the pull request lists are not dropped (SPEC-02 AC44)");
  assert.equal(handler["close-older-pull-requests"], false, "an earlier pull request stays open: its items are in the next run's baseline (SPEC-02 AC25)");
  assert.equal(handler["close-older-key"], `sdlc-drift-${project.projectKey}`);
  assert.equal(handler["exclude-lock-yml"], true);
  assert.deepEqual(handler["protected-files"], { policy: "blocked", exclude: preset.protectedFilesExclude });
  assert.equal(handler["auto-merge"], false);
  assert.equal(handler["fallback-as-issue"], true);
  assert.equal(handler.max, 1);
  assert.equal(handler["max-patch-size"], 10240);
  assert.ok(frontmatter.engine, "an engine key is rendered");
  assert.deepEqual(frontmatter.engine.args, frontmatter.network.allowed.flatMap((host) => ["--allow-url", host]), "Copilot may let curl reach exactly the hosts of network.allowed (SPEC-02 AC13)");
  assert.ok(frontmatter.tools.bash.includes("curl"), "curl reads a source page: the native web_fetch tool does not exist behind the API proxy");
  for (const word of ["gh", "wget"]) assert.equal(frontmatter.tools.bash.includes(word), false, word);
  assert.ok("web-fetch" in frontmatter.tools);
  assert.ok(frontmatter.tools.bash.includes("git"));
  assert.ok(frontmatter.tools.bash.includes("node"), "the lab's own S2 scripts and the preset's build commands run on node");
  for (const command of audit.buildCommands) assert.ok(frontmatter.tools.bash.includes(command.trim().split(/\s+/)[0]), `bash allows the first word of '${command}'`);
  assert.deepEqual(Object.keys(customJobsOf(frontmatter.jobs)), ["escalate_failure", "implement_report"]);
  assert.deepEqual(frontmatter.jobs.implement_report, implementReportJob(project.projectKey));
  const job = frontmatter.jobs.escalate_failure;
  assert.deepEqual(job.permissions, { actions: "read", contents: "read", issues: "write" });
  assert.deepEqual(job.needs, ["agent", "detection", "safe_outputs"]);
  assert.equal(job.if, "failure() && inputs.dry_run != true");
  assert.equal("concurrency" in job, false);
  assert.deepEqual(job.steps[0], { uses: "actions/checkout@v4", with: FACTORY_SPARSE });
  assert.deepEqual(job.steps.slice(1, 3), [FACTORY_TOKEN, FACTORY_INSTALL]);
  assert.deepEqual(job.steps.filter((step) => String(step.uses ?? "").startsWith("actions/create-github-app-token")), [FACTORY_TOKEN], "only the read-only factory token is minted");
  assert.ok(job.steps.some((step) => String(step.run ?? "").includes("src/drift/escalate-gate-failure.mjs")));
  assert.equal(JSON.stringify(job).includes("update-poll-state"), false);
  assert.equal("finalize_poll_state" in frontmatter.jobs, false);
}

test("AC22: the committed documentation drift workflow has the contract keys and no other", () => {
  const { frontmatter } = readWorkflow("drift-docs-site.md");
  assertContract(frontmatter, projectOf(preset, "docs-site"));
  assert.ok("web-fetch" in frontmatter.tools);
  assert.ok(frontmatter.tools.bash.includes("git") && frontmatter.tools.bash.includes("node"));
});

test("AC22: every rendered drift workflow of the preset satisfies the same shape", () => {
  for (const key of DRIFT_KEYS) assertContract(generated(key).frontmatter, projectOf(preset, key));
});

test("AC22: the escalate_failure job opts out of the detection gate so it can run after a failed agent", () => {
  const job = generated("docs-site").frontmatter.jobs.escalate_failure;
  assert.equal(job["detection-gate"], "status-only");
});

test("AC23: the values are rendered from the manifest: group, key, checkout, reviewers and draft", () => {
  const groups = DRIFT_KEYS.map((key) => generated(key).frontmatter.concurrency.group);
  assert.deepEqual(groups, DRIFT_KEYS.map((key) => `sdlc-drift-${key}`));
  assert.equal(new Set(groups).size, 3);
  for (const group of groups) assert.equal(group.startsWith("sdlc-state-"), false);
  const content = generated("lab-content").frontmatter;
  assert.equal(content.checkout[0].path, projectOf(preset, "lab-content").repo.split("/")[1]);
  assert.equal(content["safe-outputs"]["create-pull-request"]["target-repo"], projectOf(preset, "lab-content").repo);
  const improving = generated("agent-kit").frontmatter;
  assert.equal(improving["safe-outputs"]["create-pull-request"].draft, true);
  assert.equal(improving["safe-outputs"]["create-pull-request"]["close-older-key"], "sdlc-drift-agent-kit");
  assert.deepEqual(generated("docs-site").frontmatter["safe-outputs"]["create-pull-request"].reviewers, projectOf(preset, "docs-site").driftAudit.reviewers);
});

test("AC69 QA: renaming a target, within the central owner or across owners, scopes both drift and implementation publishing to its repository name rather than its project key", () => {
  for (const repo of ["example-org/renamed-target", "external-owner/renamed-target"]) {
    const manifest = mutate(minimalManifest(), (copy) => {
      projectOf(copy, "alpha-service").repo = repo;
      copy.dependencyEdges[0].upstreamRepo = repo;
    });
    const workspace = createWorkspace({ manifestText: toYaml(manifest) });
    try {
      const result = renderFleet(request, { cwd: workspace.dir });
      assert.ok(result.ok, `${repo}: ${JSON.stringify(result.result)}`);
      for (const kind of ["drift", "implement"]) {
        const { frontmatter } = parseWorkflow(result.files.get(`${W}/${kind}-alpha-service.md`));
        const outputs = frontmatter["safe-outputs"];
        assert.deepEqual(outputs["github-app"], { ...APP, repositories: ["renamed-target"] }, `${repo} ${kind}: no central repository or project key in the token scope`);
        assert.deepEqual(frontmatter.checkout[0]["github-app"], outputs["github-app"], `${repo} ${kind}: checkout and publishing reach the same target`);
        assert.equal(outputs["create-pull-request"]["target-repo"], repo);
        assert.equal(outputs[kind === "drift" ? "create-issue" : "add-comment"]["target-repo"], repo);
        assert.equal(outputs["report-failure-as-issue"], false, "gh-aw's own failure issue is off, so handle_agent_failure.cjs writes nothing to the central repository that the token cannot reach (AC69)");
      }
    } finally {
      workspace.cleanup();
    }
  }
});

test("AC23: the golden files equal the generated files byte for byte, freshly rendered and as committed", () => {
  for (const key of DRIFT_KEYS) {
    const name = `drift-${key}.md`;
    const golden = readText(abs(".github", "workflows", name));
    assert.equal(rendered.files.get(`${W}/${name}`), golden, `${name}: fresh render`);
    assert.equal(readText(abs(W, name)), golden, `${name}: committed file`);
  }
});

test("AC23: the dry_run input only exposes the flag and no staging key is rendered anywhere", () => {
  for (const key of DRIFT_KEYS) {
    const text = rendered.files.get(`${W}/drift-${key}.md`);
    assert.equal(/^\s*staged:/m.test(text), false, key);
    assert.equal(generated(key).frontmatter.on.workflow_dispatch.inputs.dry_run.type, "boolean");
  }
});

function fixtureRender() {
  const manifest = mutate(minimalManifest(), (copy) => {
    const audit = projectOf(copy, "alpha-service").driftAudit;
    audit.instructions = "INLINE-INSTRUCTIONS-MARKER keep the service current";
    audit.instructionsFile = "instructions/fixture.md";
    audit.upkeepStrategy = "code-quality-and-improvement-scan";
    audit.knowledgeSources.watchUrls = [
      { url: "https://example.org/changelog", label: "Example changelog", kind: "changelog" },
      { url: "https://blog.example.net/feed.xml", label: "Example feed", kind: "feed" },
    ];
    audit.knowledgeSources.packageManifests = ["services/api/package.json"];
    audit.buildCommands = ["npm run build:docs"];
    audit.verifyCommands = ["npm ci", "npm test", "node scripts/check.mjs --strict"];
  });
  const workspace = createWorkspace({ manifestText: toYaml(manifest), files: { "instructions/fixture.md": "FILE-INSTRUCTIONS-MARKER text that comes from the file\n" } });
  try {
    const result = renderFleet(request, { cwd: workspace.dir });
    assert.ok(result.ok, JSON.stringify(result.result));
    return parseWorkflow(result.files.get(`${W}/drift-alpha-service.md`));
  } finally {
    workspace.cleanup();
  }
}

test("AC25: the prompt body carries the instructions (inline first, then the file), strategy, watched sources, manifests and build commands", () => {
  const { body } = fixtureRender();
  const inline = body.indexOf("INLINE-INSTRUCTIONS-MARKER");
  const fromFile = body.indexOf("FILE-INSTRUCTIONS-MARKER");
  assert.ok(inline >= 0 && fromFile > inline, "inline instructions precede the instructions file");
  for (const text of [
    "code-quality-and-improvement-scan",
    "https://example.org/changelog", "Example changelog", "changelog",
    "https://blog.example.net/feed.xml", "Example feed", "feed",
    "services/api/package.json",
    "npm run build:docs",
  ]) {
    assert.ok(body.includes(text), `the body contains ${text}`);
  }
});

/** The five S2 steps that every drift workflow runs before its agent, in order (AC25; SPEC-02 AC3, AC41). */
function assertS2PreAgentSteps(steps, key, factoryPath = "$GITHUB_WORKSPACE") {
  assert.ok(steps[0].run.startsWith(`node "${factoryPath}/src/drift/prepare-run.mjs"`));
  assert.ok(steps[1].run.startsWith(`node "${factoryPath}/src/drift/dedupe-open-prs.mjs"`));
  assert.deepEqual(steps[2], {
    name: "Find the watch index of the previous run",
    env: { GH_TOKEN: "${{ github.token }}" },
    run: `node "${factoryPath}/src/drift/previous-watch-index.mjs" --out /tmp/gh-aw/agent --workflow drift-${key}.lock.yml --artifact sdlc-watch-index-${key}`,
  });
  assert.ok(steps[3].run.startsWith(`node "${factoryPath}/src/snapshot-watch-sources.mjs"`));
  assert.ok(steps[3].run.endsWith(" --previous /tmp/gh-aw/agent/previous"), "the snapshot compares with what the step before it fetched");
  assert.deepEqual(steps[4], {
    name: "Upload the watch index",
    if: "inputs.dry_run != true",
    uses: "actions/upload-artifact@v4",
    with: { name: `sdlc-watch-index-${key}`, path: "/tmp/gh-aw/agent/sources/watch-index.json", "if-no-files-found": "error" },
  }, "a dry run uploads no index, so it is never the next run's baseline");
  assert.equal(steps.filter((step) => String(step.run).includes("snapshot-watch-sources.mjs")).length, 1);
}

test("AC25: pre-agent-steps holds exactly the five S2 steps in order, with one snapshot step and no per-entry hook", () => {
  const steps = fixtureRender().frontmatter["pre-agent-steps"];
  assert.equal(steps.length, 5);
  assertS2PreAgentSteps(steps, "alpha-service");
  for (const key of DRIFT_KEYS) {
    const audit = projectOf(preset, key).driftAudit;
    const pre = generated(key).frontmatter["pre-agent-steps"];
    assert.deepEqual(pre.slice(0, 2), [FACTORY_TOKEN, FACTORY_INSTALL], key);
    assert.equal(pre.length, 7 + Number(audit.agentSandbox?.installDependencies === true), key);
    assertS2PreAgentSteps(pre.slice(2), key, FACTORY_PATH);
    const staged = audit.stagedScripts ?? [];
    if (staged.length > 0) assert.ok(pre[2].run.endsWith(` --factory-dir ${FACTORY_DIR} --stage-scripts ${staged.join(",")}`), key);
    else assert.equal(/--factory-dir|--stage-scripts/.test(pre[2].run), false, key);
  }
});

/** The minimal manifest with an agentSandbox on its drift project, rendered: the drift workflow of alpha-service, parsed, or the refusal. */
function renderSandbox(agentSandbox, renderRequest = request, change = () => undefined) {
  const manifest = mutate(minimalManifest(), (copy) => {
    if (agentSandbox !== undefined) projectOf(copy, "alpha-service").driftAudit.agentSandbox = agentSandbox;
    change(copy);
  });
  const workspace = createWorkspace({ manifestText: toYaml(manifest) });
  try {
    const result = renderFleet(renderRequest, { cwd: workspace.dir });
    return result.ok ? { ok: true, ...parseWorkflow(result.files.get(`${W}/drift-alpha-service.md`)) } : { ok: false, result: result.result };
  } finally {
    workspace.cleanup();
  }
}

test("AC25: agentSandbox.installDependencies adds one last pre-agent step, after the five S2 steps, that installs the dependencies of the target without running their scripts; without it there are exactly five", () => {
  const plain = renderSandbox(undefined).frontmatter["pre-agent-steps"];
  assert.equal(plain.length, 5);
  for (const agentSandbox of [{}, { installDependencies: false }, { bashCommands: ["awk"] }]) {
    assert.deepEqual(renderSandbox(agentSandbox).frontmatter["pre-agent-steps"], plain, `${JSON.stringify(agentSandbox)} asks for no step`);
  }
  const steps = renderSandbox({ installDependencies: true }).frontmatter["pre-agent-steps"];
  assert.equal(steps.length, 6);
  assert.deepEqual(steps.slice(0, 5), plain, "the five S2 steps are what they were");
  assert.deepEqual(steps[5], { name: "Install target checkout dependencies for in-sandbox validation", "working-directory": "alpha-service", run: "npm ci --ignore-scripts" });
});

test("AC22: agentSandbox.bashCommands extend the bash allowlist with the words that they name, sorted and once each, and nothing else of the workflow changes", () => {
  const plain = renderSandbox(undefined);
  const extended = renderSandbox({ bashCommands: ["xargs", "awk", "git", "rg", "python3"] });
  assert.deepEqual(extended.frontmatter.tools.bash, [...new Set([...plain.frontmatter.tools.bash, "awk", "python3", "rg", "xargs"])].sort());
  assert.ok(extended.frontmatter.tools.bash.length > plain.frontmatter.tools.bash.length);
  for (const word of ["gh", "wget", "*"]) assert.equal(extended.frontmatter.tools.bash.includes(word), false, word);
  assert.ok(plain.frontmatter.tools.bash.includes("curl"), "the renderer, not the manifest, adds curl, with the URL permission that bounds it");
  const without = (workflow) => ({ ...workflow.frontmatter, tools: { ...workflow.frontmatter.tools, bash: null } });
  assert.deepEqual(without(extended), without(plain));
  assert.equal(extended.body, plain.body);
});

test("AC22: a manifest cannot give a drift agent gh, curl or wget, in any case, and the refusal names the entry", () => {
  for (const word of ["gh", "curl", "wget", "GH", "Curl"]) {
    const refused = renderSandbox({ bashCommands: ["awk", word] });
    assert.equal(refused.ok, false, word);
    assert.match(JSON.stringify(refused.result), /drift-bash-command-forbidden/, word);
    assert.match(JSON.stringify(refused.result), new RegExp(`agentSandbox/bashCommands/1: '${word}'`), word);
  }
});

test("AC71: an engine that cannot enforce an allowlist keeps the wildcard that the compiler accepts, whatever agentSandbox adds", () => {
  const codex = renderSandbox({ bashCommands: ["awk"], installDependencies: true }, withRequest({ engineAuthMode: "api-key" }), (copy) => {
    copy.engineApiKeySecret = "OPENAI_API_KEY";
  });
  assert.equal(codex.ok, true, JSON.stringify(codex.result));
  assert.equal(codex.frontmatter.engine.id, "codex");
  assert.deepEqual(codex.frontmatter.tools.bash, ["*"]);
  assert.equal("args" in codex.frontmatter.engine, false, "--allow-url is a Copilot flag: another engine gets none, and the firewall alone bounds its shell");
  assert.equal(codex.frontmatter["pre-agent-steps"].length, 6, "the install step does not depend on the engine");
});

test("AC25: the deduplication step names its workflow: the close-older key that its pull requests carry and its upkeepStrategy (SPEC-02 AC10)", () => {
  const { frontmatter } = fixtureRender();
  const [, dedupe] = frontmatter["pre-agent-steps"];
  assert.match(dedupe.run, / --target-repo "\$CONFIGURED_TARGET_REPO" --close-older-key sdlc-drift-alpha-service --upkeep-strategy code-quality-and-improvement-scan$/);
  assert.equal(frontmatter["safe-outputs"]["create-pull-request"]["close-older-key"], "sdlc-drift-alpha-service", "the key is the one of the safe output, which gh-aw writes into the body of each pull request");
  for (const key of DRIFT_KEYS) {
    const step = generated(key).frontmatter["pre-agent-steps"][3];
    assert.ok(step.run.endsWith(` --close-older-key sdlc-drift-${key} --upkeep-strategy ${projectOf(preset, key).driftAudit.upkeepStrategy} --project ${key}`), `${key}: ${step.run}`);
  }
});

test("AC25: the strategy guidance comes from the repository override or the package fragment when no override exists", () => {
  const manifest = mutate(minimalManifest(), (copy) => {
    projectOf(copy, "alpha-service").driftAudit.upkeepStrategy = "content-and-docs-sync";
  });
  const edited = "## Upkeep strategy: content-and-docs-sync\n\nGUIDANCE-FROM-THE-FILE-OF-THE-REPOSITORY\n";
  const withFile = createWorkspace({ manifestText: toYaml(manifest), files: { "prompts/drift/strategy-content-and-docs-sync.md": edited } });
  const without = createWorkspace({ manifestText: toYaml(manifest) });
  const broken = createWorkspace({ manifestText: toYaml(manifest), files: { "prompts/drift/strategy-content-and-docs-sync.md": "no heading\n" } });
  try {
    const bodyOf = (workspace) => parseWorkflow(renderFleet(request, { cwd: workspace.dir }).files.get(`${W}/drift-alpha-service.md`)).body;
    assert.ok(bodyOf(withFile).includes(edited.trim()), "the file of the repository");
    assert.equal(bodyOf(withFile).includes("Compare the watched-source snapshots with the target's documentation"), false, "and not the built-in text beside it");
    assert.ok(bodyOf(without).includes(readText(abs("prompts", "drift", "strategy-content-and-docs-sync.md")).trim()), "without the file, the built-in text is the committed fragment, to the letter");
    const refused = renderFleet(request, { cwd: broken.dir });
    assert.equal(refused.ok, false);
    assert.match(JSON.stringify(refused.result), /drift-strategy-fragment/, "a file that is there and unusable is refused and not replaced");
  } finally {
    withFile.cleanup();
    without.cleanup();
    broken.cleanup();
  }
});

test("AC25: post-steps equals verifyCommands in order, each named by its command, with no continue-on-error or if", () => {
  const steps = fixtureRender().frontmatter["post-steps"];
  assert.deepEqual(steps.map((step) => step.run), ["npm ci", "npm test", "node scripts/check.mjs --strict"]);
  assert.deepEqual(steps.map((step) => step.name), ["npm ci", "npm test", "node scripts/check.mjs --strict"]);
  for (const step of steps) {
    assert.equal("continue-on-error" in step, false);
    assert.equal("if" in step, false);
    assert.equal(step["working-directory"], "alpha-service");
  }
});

test("AC25: the content post-steps run the declared validator with factory placeholders expanded", () => {
  const steps = readWorkflow("drift-lab-content.md").frontmatter["post-steps"];
  assert.ok(steps.some((step) => step.run.includes('node "$copy/scripts/validate-example.mjs"')));
  assert.deepEqual(steps.map((step) => step.run), projectOf(preset, "lab-content").driftAudit.verifyCommands.map(fillCommand));
  for (const key of DRIFT_KEYS) {
    for (const step of generated(key).frontmatter["post-steps"]) {
      assert.equal("continue-on-error" in step, false);
      assert.equal("if" in step, false);
    }
  }
});

test("AC21: instructionsFile resolves from the repository root, whichever directory the manifest is in", () => {
  const manifest = mutate(minimalManifest(), (copy) => {
    projectOf(copy, "alpha-service").driftAudit.instructionsFile = "instructions/alpha.md";
  });
  const workspace = createWorkspace({
    manifestText: toYaml(manifest),
    files: {
      "config/fleet.yaml": toYaml(manifest),
      "instructions/alpha.md": "ROOT-INSTRUCTIONS-MARKER the file at the repository root\n",
      "config/instructions/alpha.md": "MANIFEST-DIRECTORY-MARKER the file beside the manifest\n",
    },
  });
  try {
    for (const manifestPath of ["sdlc.yaml", "config/fleet.yaml"]) {
      const result = renderFleet({ ...request, manifestPath }, { cwd: workspace.dir });
      assert.ok(result.ok, `${manifestPath}: ${JSON.stringify(result.result)}`);
      const { body } = parseWorkflow(result.files.get(`${W}/drift-alpha-service.md`));
      assert.ok(body.includes("ROOT-INSTRUCTIONS-MARKER"), `${manifestPath}: the repository-root file is used`);
      assert.equal(body.includes("MANIFEST-DIRECTORY-MARKER"), false, `${manifestPath}: the file beside the manifest is not read`);
    }
  } finally {
    workspace.cleanup();
  }
});

test("AC27: a file-write spy around a reconcile run sees only .github/workflows (or the dry-run staging directory), never /tmp/gh-aw/agent", async () => {
  const workspace = createWorkspace();
  const writes = [];
  const originals = {};
  const spied = ["writeFileSync", "appendFileSync", "mkdirSync", "rmSync", "copyFileSync", "renameSync", "unlinkSync", "mkdtempSync", "cpSync"];
  for (const name of spied) {
    originals[name] = fs[name];
    fs[name] = function recorded(target, ...rest) {
      writes.push(path.resolve(String(target)));
      return originals[name].call(this, target, ...rest);
    };
  }
  try {
    await workspace.reconcile(request);
    await workspace.reconcile({ ...request, dryRun: true });
  } finally {
    for (const name of spied) fs[name] = originals[name];
  }
  try {
    assert.ok(writes.length > 0, "the spy recorded the writes");
    const workflowsDirectory = path.join(workspace.dir, ".github", "workflows");
    const stagingPrefix = path.join(os.tmpdir(), "sdlc-reconcile-");
    for (const target of writes) {
      assert.equal(target.split(path.sep).join("/").includes("/tmp/gh-aw/agent"), false, target);
      const inWorkflows = target === workflowsDirectory || target.startsWith(workflowsDirectory + path.sep);
      assert.ok(inWorkflows || target.startsWith(stagingPrefix), `unexpected write: ${target}`);
    }
    assert.ok(writes.some((target) => target.startsWith(workflowsDirectory + path.sep)), "the real run wrote under .github/workflows");
    assert.ok(writes.some((target) => target.startsWith(stagingPrefix)), "the dry run wrote only to its staging directory");
  } finally {
    workspace.cleanup();
  }
});

test("AC27: the engine contains no drift evaluation and makes no network request itself", () => {
  const source = readText(abs("src", "reconcile.mjs"));
  assert.equal(/\bfetch\s*\(|node:https?|node:net\b|node:dns|XMLHttpRequest|WebSocket/.test(source), false);
  assert.equal(/fs\.\w*(write|mkdir|append|copy|rm)\w*\([^)]*\/tmp\/gh-aw/.test(source), false);
});

// ---- the change policy (projects[].driftAudit.changePolicy): what the drift agent applies, and what its report lists for whom -----------------------------

const policyHeading = (policy) => `## Change policy: ${policy}`;
/** The line of the report's section list that describes `section` (`- \`## Recommended\`: ...`). */
const bulletOf = (body, section) => body.split("\n").find((line) => line.startsWith(`- \`${section}\`: `));
const REPORT_SECTIONS = ["## Summary", "## Recommended", "## Could not confirm", "## For a human", "## Limitations"];
const ADDITIONS = "content that the sources announce and this repository does not cover yet";
const ADDITION_EXAMPLES = "a new feature, setting, limit or retirement that deserves a lab step, a slide or a reference note";
const JUDGEMENT_HEADING = "## Judgement calls — review these";

test("changePolicy: a project without it renders exactly what corrections-only renders, and only the prompt depends on the policy, never the frontmatter", () => {
  const absent = renderPolicy(undefined);
  assert.ok(absent.drift.body.includes(policyHeading("corrections-only")), "the default is the narrowest policy");
  for (const policy of CHANGE_POLICIES) {
    const rendered = renderPolicy(policy);
    for (const kind of ["drift", "implement"]) {
      assert.equal(rendered[kind].frontmatterText, absent[kind].frontmatterText, `${policy} ${kind}: the frontmatter`);
      if (policy === "corrections-only") assert.equal(rendered[kind].body, absent[kind].body, `${kind}: an explicit corrections-only is the default, to the byte`);
      else assert.notEqual(rendered[kind].body, absent[kind].body, `${policy} ${kind}: the policy is in the prompt`);
    }
    assert.deepEqual([...rendered.files.keys()], [...absent.files.keys()]);
    for (const [file, text] of rendered.files) if (!/\/(?:drift|implement)-alpha-service\.md$/.test(file)) assert.equal(text, absent.files.get(file), `${policy}: ${file} does not depend on the policy`);
  }
});

test("changePolicy corrections-only: the drift run applies corrections only, and lists additions and judgement calls under ## For a human, never under ## Recommended", () => {
  const { body } = renderPolicy("corrections-only").drift;
  assert.equal(body.split("## Change policy: ").length - 1, 1, "exactly one policy heading");
  assert.ok(body.includes(`${policyHeading("corrections-only")}\n\nWithin the limits of the registration instructions, your pull request applies corrections only: a change where a corroborated source contradicts what this repository says. Source-backed additions (${ADDITIONS}) and judgement calls are not applied, and are never listed under \`## Recommended\`: list them under \`## For a human\``));
  assert.ok(body.indexOf("## Upkeep strategy: ") < body.indexOf(policyHeading("corrections-only")) && body.indexOf(policyHeading("corrections-only")) < body.indexOf("## Watched sources"), "after the registration instructions and the strategy, before the sources");
  const recommended = bulletOf(body, "## Recommended");
  assert.match(recommended, /^- `## Recommended`: a task list \(`- \[ \] `\) of the corrections that this run did not change and should be changed, where a corroborated source contradicts this repository\. Each item says what to change, names the files that it concerns and links its source\.$/);
  assert.doesNotMatch(recommended, /addition|judgement/, "nothing that the implementation leaves alone is recommended");
  assert.equal(bulletOf(body, "## For a human"), "- `## For a human`: a list of source-backed additions and judgement calls left for a human reviewer, each with what the source announces, the files that it concerns and its source.");
  const positions = REPORT_SECTIONS.map((section) => body.indexOf(`- \`${section}\`: `));
  assert.ok(positions.every((at) => at > 0) && positions.every((at, index) => index === 0 || at > positions[index - 1]), `the five sections, For a human between Could not confirm and Limitations: ${positions}`);
  assert.ok(body.includes("File a drift report when at least one item of the work list is recommended, could not be confirmed or is left for a human, or when this run has a limitation that a human has to know about:"), "an item for a human is a reason to file a report");
  assert.ok(body.includes("and leaves out `## Recommended`, `## Could not confirm` and `## For a human` when they would be empty:"), "and the section is left out when it would be empty");
  assert.equal(body.includes("## Judgement calls"), false, "only judgement-and-flag asks for the judgement heading");
});

test("changePolicy corrections-and-additions: the drift run applies corrections and additions, recommends both when it did not change them, and leaves judgement calls to a human", () => {
  const { body } = renderPolicy("corrections-and-additions").drift;
  assert.equal(body.split("## Change policy: ").length - 1, 1);
  assert.ok(body.includes(`${policyHeading("corrections-and-additions")}\n\nWithin the limits of the registration instructions, your pull request applies source-backed corrections and additions: a correction is a change where a corroborated source contradicts what this repository says, and an addition is ${ADDITIONS} (${ADDITION_EXAMPLES}). Judgement calls are not applied: list them under \`## For a human\``));
  const recommended = bulletOf(body, "## Recommended");
  assert.match(recommended, /^- `## Recommended`: a task list \(`- \[ \] `\) of the corrections and additions that this run did not change and should be changed: /);
  assert.ok(recommended.includes(`additions, ${ADDITIONS} (${ADDITION_EXAMPLES}).`), recommended);
  assert.doesNotMatch(recommended, /judgement/);
  assert.equal(bulletOf(body, "## For a human"), "- `## For a human`: a list of source-backed judgement calls left for a human reviewer, each with what the source announces, the files that it concerns and its source.");
  assert.ok(body.includes("File a drift report when at least one item of the work list is recommended, could not be confirmed or is left for a human, or when this run has a limitation"));
  assert.ok(body.includes("and leaves out `## Recommended`, `## Could not confirm` and `## For a human` when they would be empty:"));
  assert.equal(body.includes("## Judgement calls"), false);
});

test("changePolicy judgement-and-flag: the drift run applies corrections, additions and judgement calls, recommends what it did not change, has no ## For a human, and flags each judgement call in the pull request", () => {
  const { body } = renderPolicy("judgement-and-flag").drift;
  assert.equal(body.split("## Change policy: ").length - 1, 1);
  assert.ok(body.includes(`${policyHeading("judgement-and-flag")}\n\nWithin the limits of the registration instructions, your pull request applies source-backed corrections, additions and judgement calls: a correction is a change where a corroborated source contradicts what this repository says, an addition is ${ADDITIONS} (${ADDITION_EXAMPLES}), and a judgement call is a change that a source supports but that needs a choice which the source does not make for you. Whenever the pull request makes a judgement call, its body has a \`${JUDGEMENT_HEADING}\` heading that lists each judgement call with the files that you changed, the source and the alternatives that you considered.`));
  const recommended = bulletOf(body, "## Recommended");
  assert.match(recommended, /^- `## Recommended`: a task list \(`- \[ \] `\) of the corrections, additions and judgement calls that this run did not change and should be changed: /);
  assert.ok(recommended.includes(`additions, ${ADDITIONS} (${ADDITION_EXAMPLES}); and judgement calls, changes that a source supports but that need a choice which the source does not make for you.`), recommended);
  assert.equal(body.includes("For a human"), false, "no ## For a human section is rendered, and nothing of the prompt names one");
  assert.ok(body.includes("File a drift report when at least one item of the work list is recommended or could not be confirmed, or when this run has a limitation"), "the reasons are the ones it always had");
  assert.ok(body.includes("and leaves out `## Recommended` and `## Could not confirm` when they would be empty:"));
  const positions = ["## Summary", "## Recommended", "## Could not confirm", "## Limitations"].map((section) => body.indexOf(`- \`${section}\`: `));
  assert.ok(positions.every((at, index) => at > 0 && (index === 0 || at > positions[index - 1])), `${positions}`);
});

test("changePolicy: every upkeep strategy gets the policy of its project, after its strategy guidance and before the watched sources", () => {
  for (const strategy of ["content-and-docs-sync", "dependency-and-pattern-modernization", "code-quality-and-improvement-scan", "custom"]) {
    for (const policy of CHANGE_POLICIES) {
      const { body } = renderPolicy(policy, (copy) => (projectOf(copy, "alpha-service").driftAudit.upkeepStrategy = strategy)).drift;
      const at = body.indexOf(policyHeading(policy));
      assert.ok(at > body.indexOf("## Registration instructions") && at < body.indexOf("## Watched sources"), `${strategy} ${policy}`);
      if (strategy !== "custom") assert.ok(at > body.indexOf(`## Upkeep strategy: ${strategy}`), `${strategy} ${policy}: after the strategy`);
    }
  }
});

test("changePolicy: a value outside the three policies is refused by the schema, and the refusal names the key", () => {
  for (const policy of ["judge-and-flag", "everything", ""]) {
    const refused = renderMinimal((copy) => (projectOf(copy, "alpha-service").driftAudit.changePolicy = policy));
    assert.equal(refused.ok, false, JSON.stringify(policy));
    assert.ok(refused.errors.some((error) => error.startsWith("schema-validation: ") && error.includes("/projects/0/driftAudit/changePolicy")), refused.errors.join("\n"));
  }
});

// ---- driftAudit.model: the model of the engine of the drift and of the implementation workflow ------------------------------------------------------------

const withoutModel = (frontmatter) => ({ ...frontmatter, engine: Object.fromEntries(Object.entries(frontmatter.engine).filter(([key]) => key !== "model")) });

test("driftAudit.model is the model of the engine of the drift and of the implementation workflow, and without it no model is rendered and nothing else changes", () => {
  const plain = renderPolicy(undefined);
  for (const kind of ["drift", "implement"]) assert.equal("model" in plain[kind].frontmatter.engine, false, `${kind}: no key, no model`);
  const named = renderPolicy(undefined, (copy) => (projectOf(copy, "alpha-service").driftAudit.model = "claude-opus-4.5"));
  for (const kind of ["drift", "implement"]) {
    assert.equal(named[kind].frontmatter.engine.model, "claude-opus-4.5", kind);
    assert.deepEqual(Object.keys(named[kind].frontmatter.engine), ["id", "model", ...Object.keys(plain[kind].frontmatter.engine).filter((key) => key !== "id")], `${kind}: the model follows the id`);
    assert.deepEqual(withoutModel(named[kind].frontmatter), plain[kind].frontmatter, `${kind}: the rest of the frontmatter is what it was`);
    assert.equal(named[kind].body, plain[kind].body, `${kind}: and so is the prompt`);
  }
  assert.deepEqual(named.drift.frontmatter.engine.args, plain.drift.frontmatter.engine.args, "the URL permissions of the engine stay");
  for (const [file, text] of plain.files) if (!/\/(?:drift|implement)-alpha-service\.md$/.test(file)) assert.equal(named.files.get(file), text, `${file}: another workflow does not take the model of a project`);
});

test("driftAudit.model reaches the engine object of every engine that a request can select, next to its credentials", () => {
  for (const [secret, engine, variable] of [["ANTHROPIC_API_KEY", "claude", "ANTHROPIC_API_KEY"], ["GEMINI_API_KEY", "gemini", "GEMINI_API_KEY"], ["OPENAI_API_KEY", "codex", "OPENAI_API_KEY"]]) {
    const rendered = renderMinimal((copy) => {
      copy.engineApiKeySecret = secret;
      projectOf(copy, "alpha-service").driftAudit.model = "model-of-the-project";
    }, withRequest({ engineAuthMode: "api-key" }));
    assert.ok(rendered.ok, JSON.stringify(rendered.errors));
    for (const id of ["drift-alpha-service", "implement-alpha-service"]) {
      assert.deepEqual(rendered.workflow(id).frontmatter.engine, { id: engine, model: "model-of-the-project", env: { [variable]: `\${{ secrets.${secret} }}` } }, `${engine} ${id}`);
    }
  }
  for (const mode of ["copilot-requests", "copilot-pat"]) {
    const rendered = renderMinimal((copy) => (projectOf(copy, "alpha-service").driftAudit.model = "model-of-the-project"), withRequest({ engineAuthMode: mode }));
    assert.equal(rendered.workflow("drift-alpha-service").frontmatter.engine.model, "model-of-the-project", mode);
    assert.equal(rendered.workflow("drift-alpha-service").frontmatter.engine["copilot-sdk"], true, mode);
  }
});

test("driftAudit.model that the schema refuses is never rendered: a space, a shell metacharacter, an expression and 129 characters", () => {
  for (const model of ["two words", "a;b", "a$(b)", "${{ secrets.X }}", "a".repeat(129), "", "-x"]) {
    const refused = renderMinimal((copy) => (projectOf(copy, "alpha-service").driftAudit.model = model));
    assert.equal(refused.ok, false, JSON.stringify(model));
    assert.ok(refused.errors.some((error) => error.includes("/projects/0/driftAudit/model") || error.startsWith("manifest-expression-opener: ")), refused.errors.join("\n"));
  }
});
