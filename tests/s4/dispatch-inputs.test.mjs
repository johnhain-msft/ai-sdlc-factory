// AC24, AC25 and AC28: the dispatch inputs are validated before anything else runs, a run in which only the upstream commit advanced does what on_commit_only_advance says,
// and dry_run makes every gate run while a commit is a failure and the poll state is never written. Every case is the rendered workflow executed in bash on local checkouts.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test, { after } from "node:test";
import { git } from "./helpers/fixtures.mjs";
import { commandOf, pathsOf, verifyGate } from "./helpers/example-world.mjs";
import { createRun, dispatchInputs } from "./helpers/runtime.mjs";
import { AI, customJobs, edgeOf, globMatches, workflowOf } from "./helpers/workflows.mjs";

const HEX = "0123456789abcdef0123456789abcdef01234567";
const CONTENT = AI.find((spec) => pathsOf(spec).sourceManifest);
const PIPELINES = AI.find((spec) => pathsOf(spec).capture);
const COURSE = AI.find((spec) => spec !== CONTENT && spec !== PIPELINES);
const changedFiles = (run) => git(run.downstream, ["diff", "--name-only", "--no-renames", run.baseSha, "HEAD"]).stdout.split("\n").filter(Boolean).sort();
const allowedBy = (spec, file) => edgeOf(spec).allowedFiles.some((pattern) => globMatches(pattern, file));
const preStatuses = (run) => run.pre().map(() => 0);
const contentScope = CONTENT.scopes.find((scope) => !PIPELINES.scopes.includes(scope));
const runsScope = PIPELINES.scopes.find((scope) => !CONTENT.scopes.includes(scope));
// Validation rejects these cases before touching either checkout. Reuse those read-only repositories, not their dispatch inputs or environment.
const validationRuns = new Map();
after(() => {
  for (const run of validationRuns.values()) run.cleanup();
});
function validationRun(spec, overrides) {
  if (!validationRuns.has(spec.id)) validationRuns.set(spec.id, createRun(spec));
  const run = validationRuns.get(spec.id);
  Object.assign(run.inputs, dispatchInputs(spec, { previous_sha: run.previousSha, upstream_sha: run.upstreamSha, ...overrides }));
  run.box.writeEnv();
  return run;
}

// ---- AC24: the validation step ---------------------------------------------------------------------------------------------------------------------------------

const REFUSED = [
  ["sync_scope outside the workflow's declared scopes", CONTENT, { sync_scope: "everything" }, /sync_scope/],
  ["sync_scope that is empty", CONTENT, { sync_scope: "" }, /sync_scope/],
  ["a runs scope sent to the content workflow", CONTENT, { sync_scope: runsScope }, /sync_scope/],
  ["a content scope sent to the runs workflow", PIPELINES, { sync_scope: contentScope }, /sync_scope/],
  ["a content scope sent to a default-scope workflow", COURSE, { sync_scope: contentScope }, /sync_scope/],
  ["on_commit_only_advance that is neither noop nor bump-provenance", CONTENT, { on_commit_only_advance: "merge" }, /on_commit_only_advance/],
  ["on_commit_only_advance that is empty", CONTENT, { on_commit_only_advance: "" }, /on_commit_only_advance/],
  ["downstream_repo that is not the workflow's downstream", CONTENT, { downstream_repo: "example-org/other-downstream" }, /downstream_repo/],
  ["upstream_repo that is not the upstream of the workflow", PIPELINES, { upstream_repo: CONTENT.upstreamRepo }, /upstream_repo/],
  ["upstream_sha that is a short sha", CONTENT, { upstream_sha: "abc1234" }, /upstream_sha/],
  ["upstream_sha in capitals", CONTENT, { upstream_sha: HEX.toUpperCase() }, /upstream_sha/],
  ["upstream_sha that is empty", CONTENT, { upstream_sha: "" }, /upstream_sha/],
  ["previous_sha that is not hexadecimal", CONTENT, { previous_sha: "z".repeat(40) }, /previous_sha/],
  ["previous_sha that is empty", COURSE, { previous_sha: "" }, /previous_sha/],
  ["dry_run that is yes", CONTENT, { dry_run: "yes" }, /dry_run/],
  ["dry_run in capitals", CONTENT, { dry_run: "TRUE" }, /dry_run/],
];

for (const [label, spec, override, message] of REFUSED) {
  test(`AC24: ${label}: validation exits 2 before evidence or adaptation and the downstream is untouched`, () => {
    const run = validationRun(spec, override);
    const results = run.runPre();
    const validation = run.pre().findIndex((step) => step.name === "Validate dispatch inputs and checkouts");
    assert.equal(results.length, validation + 1, "nothing after validation ran");
    assert.deepEqual(results.slice(0, -1).map((result) => result.status), preStatuses(run).slice(0, validation), "the local factory setup passed");
    assert.equal(results.at(-1).status, 2, results.at(-1).stderr);
    assert.match(results.at(-1).stderr, message);
    assert.equal(run.porcelain(), "");
    assert.equal(run.head(), run.baseSha);
    assert.equal(run.hasArtifact("dispatch-inputs.json"), false, "nothing was recorded for the agent");
  });
}

test("AC24: one passing dispatch per workflow, for every scope that the workflow accepts, with both on_commit_only_advance values and the three dry_run values", () => {
  for (const spec of AI) {
    const run = createRun(spec);
    let attempt = 0;
    try {
      for (const scope of spec.scopes) {
        for (const [advance, dry] of [["noop", ""], ["bump-provenance", "true"], ["noop", "false"]]) {
          Object.assign(run.inputs, { sync_scope: scope, on_commit_only_advance: advance, dry_run: dry });
          run.box.writeEnv();
          // Keep the evidence of each dispatch separate: a missing write must not be hidden by a preceding dispatch's artifact.
          fs.renameSync(run.box.artifacts, path.join(run.box.root, `earlier-evidence-${attempt++}`));
          fs.mkdirSync(run.box.artifacts);
          const results = run.runPre();
          assert.deepEqual(results.map((result) => result.status), preStatuses(run), `${spec.id} ${scope} ${advance} ${JSON.stringify(dry)}: ${JSON.stringify(results.map((result) => result.stderr))}`);
          assert.equal(JSON.parse(run.artifact("dispatch-inputs.json")).dry_run, dry);
        }
      }
    } finally {
      run.cleanup();
    }
  }
});

// ---- AC25: previous_sha..upstream_sha, and a run in which only the commit advanced ------------------------------------------------------------------------------

test("AC25: the workflows compute the cumulative range previous_sha..upstream_sha from the dispatch and never read the poll state", () => {
  const run = createRun(CONTENT);
  try {
    run.runPre();
    const range = git(run.upstream, ["diff", "--name-status", run.previousSha, run.upstreamSha]).stdout;
    assert.equal(run.artifact("upstream-diff.txt"), range);
    for (const spec of AI) {
      const text = JSON.stringify(workflowOf(spec).frontmatter);
      for (const banned of ["SDLC_SYNC_STATE", "lastMergedUpstreamSha", "openPrTargetSha", "inFlightRunId"]) assert.equal(text.includes(banned), false, `${spec.id}: ${banned}`);
    }
  } finally {
    run.cleanup();
  }
});

test("AC25: noop: when only the upstream commit advanced and the agent has nothing to adapt, the worktree is untouched (AGENT_HEAD_SHA == BASE_SHA) and every post-step passes", () => {
  for (const spec of AI) {
    const run = createRun(spec, { sourceChanged: false, inputs: { on_commit_only_advance: "noop" } });
    try {
      assert.deepEqual(run.runPre().map((result) => result.status), preStatuses(run), spec.id);
      assert.equal(run.porcelain(), "");
      const post = run.runPost();
      assert.deepEqual(post.map((result) => result.status), post.map(() => 0), `${spec.id}: ${JSON.stringify(post.filter((result) => result.status !== 0))}`);
      assert.equal(run.head(), run.baseSha, `${spec.id}: HEAD unchanged`);
      assert.equal(run.porcelain(), "", `${spec.id}: git status --porcelain prints nothing`);
      assert.equal(run.box.environment().AGENT_HEAD_SHA, run.baseSha, `${spec.id}: AGENT_HEAD_SHA == BASE_SHA`);
    } finally {
      run.cleanup();
    }
  }
});

test("AC25: bump-provenance: the deterministic sequence of the prompt records upstream_sha in the provenance files and changes nothing outside the workflow's allowed-files", () => {
  for (const spec of AI) {
    const run = createRun(spec, { sourceChanged: false, inputs: { on_commit_only_advance: "bump-provenance" } });
    try {
      assert.deepEqual(run.runPre().map((result) => result.status), preStatuses(run), spec.id);
      const agent = run.agentRuns();
      assert.equal(agent.status, 0, `${spec.id}: ${agent.stdout}${agent.stderr}`);
      assert.notEqual(run.head(), run.baseSha, `${spec.id}: the provenance bump is committed`);
      const files = changedFiles(run);
      assert.ok(files.length > 0, spec.id);
      for (const file of files) assert.ok(allowedBy(spec, file), `${spec.id}: ${file} is outside the allowed files`);
      assert.equal(run.porcelain(), "", `${spec.id}: nothing is left uncommitted`);
      const show = (file) => JSON.parse(git(run.downstream, ["show", `HEAD:${file}`]).stdout);
      if (spec === CONTENT) {
        const paths = pathsOf(spec);
        assert.equal(show(paths.provenance).commit, run.upstreamSha);
        assert.equal(show(paths.inputProvenance).commit, run.upstreamSha);
        assert.equal(show(paths.sourceManifest)._provenance.commit, run.upstreamSha);
        assert.equal(show(paths.generated).commit, run.upstreamSha, "the generated provenance is rebuilt too");
        for (const file of [paths.provenance, paths.inputProvenance, paths.sourceManifest, paths.generated]) assert.ok(files.includes(file), `${file}: the revision advances`);
        for (const pattern of Object.values(edgeOf(spec).adaptation.pullRequestResult)) {
          for (const file of files) assert.equal(globMatches(pattern, file), false, `${file}: no content page or view is rewritten by a provenance-only bump`);
        }
      } else {
        const provenance = show(spec.provenanceFile);
        assert.deepEqual(provenance, { repository: spec.upstreamRepo, commit: run.upstreamSha }, spec.id);
        assert.deepEqual(files, [spec.provenanceFile], `${spec.id}: only the provenance file changes in a bump`);
      }
    } finally {
      run.cleanup();
    }
  }
});

// ---- AC28: dry_run ---------------------------------------------------------------------------------------------------------------------------------------------

test("AC28: dry_run true: every gate still runs, a clean tree passes, and a commit that the agent made despite the ban fails post-steps at the dry-run check", () => {
  for (const spec of AI) {
    const clean = createRun(spec, { sourceChanged: false, inputs: { dry_run: "true" } });
    try {
      assert.deepEqual(clean.runPre().map((result) => result.status), preStatuses(clean), spec.id);
      const post = clean.runPost();
      assert.deepEqual(post.map((result) => result.status), post.map(() => 0), spec.id);
      assert.ok(post.some((result) => /verify-immutable-gates/.test(result.name)), `${spec.id}: the immutable-gate helper still ran`);
      assert.equal(post.length, clean.post().length, `${spec.id}: no post-step was bypassed`);
      for (const command of verifyGate(spec).map(commandOf)) assert.ok(post.some((result) => result.name === command), `${spec.id}: ${command} still ran`);
    } finally {
      clean.cleanup();
    }
    const committed = createRun(spec, { sourceChanged: false, inputs: { dry_run: "true", on_commit_only_advance: "bump-provenance" } });
    try {
      assert.deepEqual(committed.runPre().map((result) => result.status), preStatuses(committed), spec.id);
      assert.equal(committed.agentRuns().status, 0, "the agent disobeys and commits");
      const post = committed.runPost();
      const last = post.at(-1);
      assert.equal(last.status, 1, `${spec.id}: ${JSON.stringify(post.map((result) => [result.name, result.status]))}`);
      assert.match(last.name, /a dry run must not leave a commit/);
      assert.match(last.stderr, /dry_run is true but the agent committed/);
      assert.deepEqual(post.slice(0, -1).map((result) => result.status), post.slice(0, -1).map(() => 0), "every gate before it passed");
    } finally {
      committed.cleanup();
    }
    // with dry_run empty or false the same commit is not a failure
    const real = createRun(spec, { sourceChanged: false, inputs: { dry_run: "false", on_commit_only_advance: "bump-provenance" } });
    try {
      real.runPre();
      assert.equal(real.agentRuns().status, 0);
      const post = real.runPost();
      assert.deepEqual(post.map((result) => result.status), post.map(() => 0), `${spec.id}: ${JSON.stringify(post.filter((result) => result.status !== 0))}`);
    } finally {
      real.cleanup();
    }
  }
});

test("AC28: finalize_poll_state and escalate_failure are guarded by dry_run, and every step that invokes the poll-state script carries the same guard", () => {
  for (const spec of AI) {
    const { finalize_poll_state: finalize, escalate_failure: escalate } = customJobs(spec);
    assert.equal(finalize.if, "success() && inputs.dry_run != 'true'", spec.id);
    assert.equal(escalate.if, "failure() && inputs.dry_run != 'true'", spec.id);
    for (const job of [finalize, escalate]) {
      const steps = job.steps.filter((step) => String(step.run ?? "").includes("update-poll-state.mjs"));
      assert.equal(steps.length, 1, spec.id);
      assert.equal(steps[0].if, "inputs.dry_run != 'true'", spec.id);
    }
  }
});

test("AC28: the prompt forbids git commit and create_pull_request when dry_run is true", () => {
  for (const spec of AI) {
    const { body } = workflowOf(spec);
    assert.match(body, /When the dispatch input `dry_run` is `true`, do not run `git commit` and do not call `create_pull_request`\./, spec.id);
  }
});
