// AC43, AC44, AC45, AC51, AC53 and AC70: the AI adaptation workflows of contract C4.
import assert from "node:assert/strict";
import test from "node:test";
import { renderFleet } from "../../src/reconcile.mjs";
import { abs, edgeOf, mutate, parseWorkflow, PRESET_ROOT, presetManifest, readText, readWorkflow, referenceRequest, toYaml } from "./helpers/fixtures.mjs";
import { FACTORY_DIR, FACTORY_INSTALL, FACTORY_PATH, FACTORY_TOKEN, fillCommand } from "./helpers/factory.mjs";
import { createWorkspace } from "./helpers/workspace.mjs";

const W = ".github/workflows";
const request = referenceRequest();
const preset = presetManifest();
const APP = { "client-id": "${{ vars.APP_CLIENT_ID }}", "private-key": "${{ secrets.APP_PRIVATE_KEY }}" };
const IDENTITIES = preset.dependencyEdges.filter((edge) => edge.mode === "ai-adaptation").map((edge) => ({
  ...edge,
  concurrencyGroup: `sdlc-state-${edge.upstreamKey}`,
  repo: edge.upstreamRepo.split("/")[1],
  downstream: edge.downstreamRepo.split("/")[1],
}));
const fillCheckout = fillCommand;
const workflowOf = (identity) => readWorkflow(`cascade-ai-${identity.edgeId}.md`);

test("AC43: each AI workflow's four identity values equal the strings of the preset", () => {
  for (const identity of IDENTITIES) {
    const edge = edgeOf(preset, identity.edgeId);
    const { frontmatter, body } = workflowOf(identity);
    assert.equal(edge.upstreamKey, identity.upstreamKey);
    assert.equal(edge.branchName, identity.branchName);
    assert.equal(edge.closeOlderKey, identity.closeOlderKey);
    assert.equal(frontmatter.concurrency.group, identity.concurrencyGroup);
    assert.equal(frontmatter["safe-outputs"]["create-pull-request"]["close-older-key"], identity.closeOlderKey);
    assert.ok(body.includes(identity.branchName), `${identity.edgeId}: the body names the branch`);
    assert.ok(frontmatter["pre-agent-steps"][3].run.includes(`echo "BRANCH_NAME=${identity.branchName}"`), `${identity.edgeId}: BRANCH_NAME is exported`);
    assert.equal(frontmatter.concurrency["cancel-in-progress"], false);
  }
});

test("AC43: the AI workflows are the only cascade-ai files of the preset and the golden files equal the fresh render", () => {
  const rendered = renderFleet(request, { cwd: PRESET_ROOT });
  const names = [...rendered.files.keys()].filter((file) => /cascade-ai-[^/]+\.md$/.test(file));
  assert.deepEqual(names, IDENTITIES.map((identity) => `${W}/cascade-ai-${identity.edgeId}.md`).sort());
  for (const name of names) {
    const base = name.split("/").pop();
    assert.equal(readText(abs(name)), rendered.files.get(name), `${base}: committed`);
  }
});

test("AC44: on is workflow_dispatch with the ten string inputs of contract C7, plus on.bots", () => {
  for (const identity of IDENTITIES) {
    const { frontmatter } = workflowOf(identity);
    assert.deepEqual(Object.keys(frontmatter.on).sort(), ["bots", "workflow_dispatch"]);
    assert.deepEqual(frontmatter.on.bots, [`${request.appSlug}[bot]`]);
    const inputs = frontmatter.on.workflow_dispatch.inputs;
    assert.deepEqual(Object.keys(inputs).sort(), [
      "correlation_id", "downstream_repo", "dry_run", "on_commit_only_advance", "previous_sha", "sync_scope", "upstream_etag", "upstream_pr_number", "upstream_repo", "upstream_sha",
    ]);
    for (const [name, input] of Object.entries(inputs)) assert.equal(input.type, "string", `${identity.edgeId}.${name}`);
  }
});

test("AC44: concurrency, engine, permissions and the two checkouts (one current, the upstream pinned with full history)", () => {
  for (const identity of IDENTITIES) {
    const { frontmatter } = workflowOf(identity);
    assert.deepEqual(frontmatter.concurrency, { group: identity.concurrencyGroup, "cancel-in-progress": false });
    assert.ok(frontmatter.engine);
    assert.deepEqual(frontmatter.permissions, { contents: "read", issues: "read", "pull-requests": "read" });
    const edge = edgeOf(preset, identity.edgeId);
    assert.deepEqual(frontmatter.checkout, [
      { repository: edge.downstreamRepo, path: identity.downstream, current: true, "github-app": { ...APP, repositories: [identity.downstream] } },
      { repository: edge.upstreamRepo, path: `upstream/${identity.repo}`, ref: "${{ inputs.upstream_sha }}", "fetch-depth": 0, "github-app": { ...APP, repositories: [identity.repo] } },
    ]);
    assert.equal(frontmatter.checkout.filter((entry) => entry.current === true).length, 1);
  }
});

test("AC44: steps set up the declared Node version, installDirectories and setupSteps in order", () => {
  for (const identity of IDENTITIES) {
    const { steps } = workflowOf(identity).frontmatter;
    const version = identity.nodeVersion ?? "24";
    assert.deepEqual(steps, [
      { name: `Set up Node.js ${version}`, uses: "actions/setup-node@v4", with: { "node-version": version } },
      ...(identity.installDirectories ?? ["."]).map((directory) => ({
        name: `Install dependencies (${directory === "." ? "root" : directory})`,
        run: "npm ci --include=dev",
        "working-directory": directory === "." ? identity.downstream : `${identity.downstream}/${directory}`,
      })),
      ...(identity.setupSteps ?? []).map((step) => ({
        name: step.name,
        run: step.run,
        "working-directory": !step.workingDirectory || step.workingDirectory === "." ? identity.downstream : `${identity.downstream}/${step.workingDirectory}`,
      })),
    ], identity.edgeId);
  }
});

test("AC44: pre-agent-steps install the factory, then validate, record BASE_SHA, capture drift and guard the clean tree", () => {
  for (const identity of IDENTITIES) {
    const edge = edgeOf(preset, identity.edgeId);
    const steps = workflowOf(identity).frontmatter["pre-agent-steps"];
    assert.equal(steps.length, 6, identity.edgeId);
    assert.deepEqual(steps.slice(0, 2), [FACTORY_TOKEN, FACTORY_INSTALL]);
    const [validate, base, capture, guard] = steps.slice(2);
    assert.ok(validate.run.includes("^[0-9a-f]{40}$") && validate.run.includes("sync_scope") && validate.run.includes(edge.upstreamRepo), `${identity.edgeId}: validation`);
    assert.ok(validate.run.includes(`git -C "$GITHUB_WORKSPACE/upstream/${identity.repo}" rev-parse HEAD`), "the upstream checkout is verified at upstream_sha");
    const baseRun = base.run;
    assert.ok(baseRun.includes(`BASE_SHA="$(git -C "$GITHUB_WORKSPACE/${identity.downstream}" rev-parse HEAD)"`));
    assert.ok(baseRun.includes("/tmp/gh-aw/base-sha.txt"));
    assert.ok(
      baseRun.includes(`{ echo "BASE_SHA=$BASE_SHA"; echo "UPSTREAM_SHA=$UPSTREAM_SHA"; echo "PREVIOUS_SHA=$PREVIOUS_SHA"; echo "BRANCH_NAME=${edge.branchName}"; echo "UPSTREAM_DIR=$GITHUB_WORKSPACE/upstream/${identity.repo}"; } >> "$GITHUB_ENV"`),
      `${identity.edgeId}: the five variables are appended to GITHUB_ENV`,
    );
    for (const artifact of ["upstream-diff.txt", "dispatch-inputs.json", "existing-pr.json"]) assert.ok(baseRun.includes(`/tmp/gh-aw/agent/${artifact}`), artifact);
    assert.equal(base.env.UPSTREAM_SHA, "${{ inputs.upstream_sha }}");
    assert.equal(base.env.PREVIOUS_SHA, "${{ inputs.previous_sha }}");
    for (const command of edge.preflightCommands) assert.ok(capture.run.includes(fillCheckout(command).replace(/"\$UPSTREAM_DIR"/g, '"$UPSTREAM_DIR"')) || capture.run.includes(command.split("<checkout>").join('"$UPSTREAM_DIR"')), `${identity.edgeId}: ${command}`);
    const writes = [...capture.run.matchAll(/>\s*(\/[^\s"']+)/g)].map((match) => match[1]);
    assert.ok(writes.length > 0, "the capture hooks write artifacts");
    for (const target of writes) assert.ok(target.startsWith("/tmp/gh-aw/agent/"), `${identity.edgeId}: ${target} is under /tmp/gh-aw/agent/`);
    assert.ok(guard.run.includes(`git -C "$GITHUB_WORKSPACE/${identity.downstream}" status --porcelain`));
    assert.ok(guard.run.includes("exit 1"));
  }
});

test("AC45: the create-pull-request handler equals the AI shape for the three preset workflows, deep equal", () => {
  for (const identity of IDENTITIES) {
    const edge = edgeOf(preset, identity.edgeId);
    const expected = {
      "target-repo": edge.downstreamRepo,
      "title-prefix": "feat(cascade): ",
      labels: ["automated", "sdlc-cascade", "ai-adapted", "needs-review"],
      reviewers: edge.reviewers,
      draft: false,
      "preserve-branch-name": true,
      "recreate-ref": true,
      "close-older-pull-requests": true,
      "close-older-key": edge.closeOlderKey,
      "if-no-changes": "ignore",
      "auto-merge": false,
      "fallback-as-issue": false,
      "allowed-files": edge.allowedFiles,
      "exclude-lock-yml": true,
      "protected-files": { policy: "blocked", exclude: edge.protectedFilesExclude },
      max: 1,
      "max-patch-size": 10240,
    };
    const outputs = workflowOf(identity).frontmatter["safe-outputs"];
    assert.deepEqual(outputs["create-pull-request"], expected, identity.edgeId);
    assert.deepEqual(outputs["github-app"], { ...APP, repositories: ["${{ github.event.repository.name }}", identity.downstream] });
    assert.equal(outputs["report-failure-as-issue"], false);
    assert.deepEqual(outputs["threat-detection"], { "continue-on-error": false });
  }
});

test("AC45: no AI workflow can fall back to an issue and none has staging or allow-workflows", () => {
  for (const identity of IDENTITIES) {
    const text = readText(abs(W, `cascade-ai-${identity.edgeId}.md`));
    assert.equal(text.includes("fallback-as-issue: true"), false);
    assert.equal(/staged|allow-workflows/.test(text), false);
  }
});

test("AC53: the first post-step reads the base, records the head, writes cascade-shas.json and appends both values", () => {
  for (const identity of IDENTITIES) {
    const run = workflowOf(identity).frontmatter["post-steps"][0].run;
    const parts = [
      'BASE_SHA="$(cat /tmp/gh-aw/base-sha.txt)"',
      "exit 1",
      `AGENT_HEAD_SHA="$(git -C "$GITHUB_WORKSPACE/${identity.downstream}" rev-parse HEAD)"`,
      "/tmp/gh-aw/cascade-shas.json",
      '{ echo "BASE_SHA=$BASE_SHA"; echo "AGENT_HEAD_SHA=$AGENT_HEAD_SHA"; } >> "$GITHUB_ENV"',
    ];
    const positions = parts.map((part) => run.indexOf(part));
    assert.ok(positions.every((position) => position >= 0), `${identity.edgeId}: ${positions}`);
    assert.deepEqual(positions, [...positions].sort((a, b) => a - b));
    assert.ok(run.includes('{"baseSha":"$BASE_SHA","headSha":"$AGENT_HEAD_SHA"}'));
    assert.ok(run.includes("^[0-9a-f]{40}$"));
  }
});

test("AC53: then the artifact upload, the helper with the workflow's own id and $BASE_SHA, then the edge's verifyCommands in order", () => {
  for (const identity of IDENTITIES) {
    const edge = edgeOf(preset, identity.edgeId);
    const steps = workflowOf(identity).frontmatter["post-steps"];
    assert.equal(steps[1].uses, "actions/upload-artifact@v4");
    assert.equal(steps[1].with.name, "sdlc-cascade-shas-${{ github.run_id }}");
    assert.equal(
      steps[2].run,
      `node --frozen-intrinsics "${FACTORY_PATH}/src/verify-immutable-gates.mjs" --downstream "$GITHUB_WORKSPACE/${identity.downstream}" --base "$BASE_SHA" --workflow cascade-ai-${identity.edgeId}`,
    );
    const after = steps.slice(3);
    assert.equal(after.length, edge.verifyCommands.length, identity.edgeId);
    edge.verifyCommands.forEach((command, index) => {
      const step = after[index];
      if (command.trimStart().startsWith("#")) assert.equal(step.run.trim(), fillCheckout(command).trim(), `${identity.edgeId}: post-run check ${index}`);
      else if (command === `git -C "$GITHUB_WORKSPACE/${identity.downstream}" status --porcelain`) {
        assert.equal(step.name, command);
        assert.ok(step.run.includes("status --porcelain") && step.run.includes("exit 1"));
      } else assert.equal(step.run, command, `${identity.edgeId}: ${command}`);
      assert.equal("continue-on-error" in step, false);
      assert.equal("if" in step, false);
    });
  }
});

test("AC53: verifyCommands are rendered verbatim and in manifest order wherever a post-run check sits among them", () => {
  const isPostRunCheck = (command) => command.trimStart().startsWith("#");
  const cleanTreeCheck = 'git -C "$GITHUB_WORKSPACE/hub" status --porcelain';
  const reordered = mutate(preset, (copy) => {
    const edge = edgeOf(copy, "course-to-hub");
    const checks = edge.verifyCommands.filter(isPostRunCheck);
    const gates = edge.verifyCommands.filter((command) => !isPostRunCheck(command));
    assert.equal(checks.length, 3, "the preset edge has three post-run checks to move around");
    // one check first, one between the build commands and the lint, and the last one at the end
    edge.verifyCommands = [checks[0], ...gates.slice(0, 4), checks[1], ...gates.slice(4), checks[2]];
  });
  const edge = edgeOf(reordered, "course-to-hub");
  assert.ok(isPostRunCheck(edge.verifyCommands[0]) && isPostRunCheck(edge.verifyCommands[5]) && isPostRunCheck(edge.verifyCommands.at(-1)));
  const workspace = createWorkspace({ manifestText: toYaml(reordered), instructions: true });
  try {
    const result = renderFleet(request, { cwd: workspace.dir });
    assert.ok(result.ok, JSON.stringify(result.result));
    const steps = parseWorkflow(result.files.get(`${W}/cascade-ai-course-to-hub.md`)).frontmatter["post-steps"].slice(3);
    assert.equal(steps.length, edge.verifyCommands.length);
    edge.verifyCommands.forEach((command, index) => {
      const step = steps[index];
      if (command === cleanTreeCheck) {
        assert.equal(step.name, command, `position ${index}`);
        assert.ok(step.run.includes("status --porcelain") && step.run.includes("exit 1"), `position ${index}`);
      } else {
        assert.equal(step.run.trim(), fillCheckout(command).trim(), `position ${index}: ${command.split("\n")[0]}`);
      }
    });
    assert.ok(steps[0].run.includes("# post-run check: a dry run must not leave a commit"), "the check that the manifest lists first runs first");
  } finally {
    workspace.cleanup();
  }
});

test("AC53: the helper carries the downstream checkout path when the downstream repository has another name", () => {
  const manifest = mutate(preset, (copy) => {
    for (const edge of copy.dependencyEdges) edge.downstreamRepo = "example-org/site";
  });
  const workspace = createWorkspace({ manifestText: toYaml(manifest), instructions: true });
  try {
    const result = renderFleet(request, { cwd: workspace.dir });
    assert.ok(result.ok, JSON.stringify(result.result));
    const { frontmatter } = parseWorkflow(result.files.get(`${W}/cascade-ai-lab-to-hub.md`));
    assert.ok(frontmatter["post-steps"][2].run.includes('--downstream "$GITHUB_WORKSPACE/site"'));
    assert.equal(frontmatter.checkout[0].path, "site");
    assert.ok(frontmatter["post-steps"][0].run.includes('git -C "$GITHUB_WORKSPACE/site" rev-parse HEAD'));
  } finally {
    workspace.cleanup();
  }
});

test("AC70: each body carries the instructions, accept and build commands, the range, allowed and locked paths and the branch", () => {
  for (const identity of IDENTITIES) {
    const edge = edgeOf(preset, identity.edgeId);
    const { body } = workflowOf(identity);
    assert.ok(body.includes(edge.adaptationInstructions.replace(/\s+/g, " ").trim()), `${identity.edgeId}: adaptationInstructions`);
    for (const command of [...edge.acceptCommands, ...edge.buildCommands]) assert.ok(body.includes(fillCheckout(command).trim()), `${identity.edgeId}: ${command}`);
    assert.ok(body.includes("previous_sha..upstream_sha"));
    for (const entry of edge.allowedFiles) assert.ok(body.includes(`\`${entry}\``), `${identity.edgeId}: allowed ${entry}`);
    for (const entry of edge.immutableGates.zeroDiffPaths) assert.ok(body.includes(`\`${entry}\``), `${identity.edgeId}: locked ${entry}`);
    assert.ok(body.includes(edge.branchName));
    assert.equal(body.includes("<checkout>"), false);
  }
});

test("AC70: editing only adaptationInstructions in a fixture manifest changes only the body of that workflow", () => {
  const edited = mutate(preset, (copy) => {
    edgeOf(copy, "lab-to-hub").adaptationInstructions = "A different instruction text for the content edge.";
  });
  const workspaceA = createWorkspace({ manifestText: toYaml(preset), instructions: true });
  const workspaceB = createWorkspace({ manifestText: toYaml(edited), instructions: true });
  try {
    const before = renderFleet(request, { cwd: workspaceA.dir });
    const after = renderFleet(request, { cwd: workspaceB.dir });
    assert.ok(before.ok && after.ok);
    const changed = [...before.files.keys()].filter((name) => before.files.get(name) !== after.files.get(name));
    assert.deepEqual(changed, [`${W}/cascade-ai-lab-to-hub.md`]);
    const a = parseWorkflow(before.files.get(changed[0]));
    const b = parseWorkflow(after.files.get(changed[0]));
    assert.equal(a.frontmatterText, b.frontmatterText, "the frontmatter is unchanged");
    assert.notEqual(a.body, b.body);
    assert.ok(b.body.includes("A different instruction text for the content edge."));
  } finally {
    workspaceA.cleanup();
    workspaceB.cleanup();
  }
});

test("AC51: reconcile never creates, modifies or deletes helper scripts and only references them from rendered steps and the body", async () => {
  const scripts = ["scripts/check-sources.mjs", "scripts/classify-report.mjs", `${FACTORY_DIR}/src/verify-immutable-gates.mjs`];
  const files = Object.fromEntries(scripts.map((script) => [script, `// sentinel for ${script}\n`]));
  const workspace = createWorkspace({ files });
  try {
    const before = workspace.hash(["node_modules", "scripts"]);
    const result = await workspace.reconcile(request);
    assert.equal(result.status, "ok", JSON.stringify(result.validationResults));
    assert.equal(workspace.hash(["node_modules", "scripts"]), before);
    for (const script of scripts) assert.equal(workspace.read(script), files[script]);
    for (const identity of IDENTITIES) {
      const { frontmatter } = parseWorkflow(workspace.read(`${W}/cascade-ai-${identity.edgeId}.md`));
      const { "pre-agent-steps": pre, "post-steps": post, ...rest } = frontmatter;
      assert.equal(/check-sources|classify-report|verify-immutable-gates/.test(JSON.stringify(rest)), false, `${identity.edgeId}: referenced only from pre-agent-steps and post-steps`);
      assert.ok(JSON.stringify(post).includes("verify-immutable-gates.mjs"));
    }
  } finally {
    workspace.cleanup();
  }
});

test("AC51: the AI workflows render no write to SDLC_SYNC_STATE outside the two jobs of AC49", () => {
  for (const identity of IDENTITIES) {
    const { frontmatter, body } = workflowOf(identity);
    const { jobs, ...outside } = frontmatter;
    assert.equal(/SDLC_SYNC_STATE|update-poll-state|gh variable/.test(JSON.stringify(outside) + body), false, identity.edgeId);
  }
});

// ---- the shell of the agent: what it may run, and what its prompt says about it -------------------------------------------------------------------------

/** The first word of a command, as the renderer takes it for the allowlist: after any VARIABLE=value prefix, when it is a plain name or path. */
const firstWordOf = (command) => command.trim().split(/\s+/).find((token) => !/^[A-Za-z_][A-Za-z0-9_]*=/.test(token));
const BASE_BASH = ["cat", "date", "find", "git", "grep", "head", "ls", "tail", "wc"];

test("the agent of an AI adaptation may run cd, as the block of its commands begins with it, and git, the base list and the first word of each accept and build command, and never curl, gh or wget", () => {
  const rendered = renderFleet(request, { cwd: PRESET_ROOT });
  for (const identity of IDENTITIES) {
    const edge = edgeOf(preset, identity.edgeId);
    const words = [...edge.importCommands, ...edge.acceptCommands, ...edge.buildCommands].map(firstWordOf).filter((word) => /^[A-Za-z0-9_.+/-]+$/.test(word));
    const expected = [...new Set([...BASE_BASH, "cd", "git", ...words])].sort();
    for (const { frontmatter, body } of [workflowOf(identity), parseWorkflow(rendered.files.get(`${W}/cascade-ai-${identity.edgeId}.md`))]) {
      assert.deepEqual(frontmatter.tools.bash, expected, identity.edgeId);
      assert.ok(frontmatter.tools.bash.includes("cd"), `${identity.edgeId}: the prompt starts its commands with a cd that a list without cd would refuse`);
      assert.ok(body.includes(`cd "$GITHUB_WORKSPACE/${identity.downstream}"`), `${identity.edgeId}: the cd that the allowlist has to permit`);
      for (const tool of ["gh", "curl", "wget", "*"]) assert.equal(frontmatter.tools.bash.includes(tool), false, `${identity.edgeId}: ${tool}`);
    }
  }
});

test("the prompt of an AI adaptation says that its shell refuses a redirection or a heredoc, and that files are written with the edit tool: one bullet under Rules, after the others", () => {
  const BULLET = "- The shell of this workflow refuses a redirection or a heredoc; write files with the edit tool.";
  const rendered = renderFleet(request, { cwd: PRESET_ROOT });
  for (const identity of IDENTITIES) {
    for (const { body } of [workflowOf(identity), parseWorkflow(rendered.files.get(`${W}/cascade-ai-${identity.edgeId}.md`))]) {
      const rules = body.slice(body.indexOf("## Rules\n"));
      assert.ok(rules.startsWith("## Rules\n"), identity.edgeId);
      const bullets = rules.split("\n").filter((line) => line.startsWith("- "));
      assert.equal(bullets.at(-1), BULLET, `${identity.edgeId}: the last rule`);
      assert.equal(body.split(BULLET).length - 1, 1, `${identity.edgeId}: once`);
      assert.ok(bullets.length >= 4 && bullets.slice(0, 3).every((line) => line !== BULLET), `${identity.edgeId}: the three rules that it always had come first`);
    }
  }
  assert.ok("edit" in workflowOf(IDENTITIES[0]).frontmatter.tools, "and it has the edit tool that the rule sends it to");
});
