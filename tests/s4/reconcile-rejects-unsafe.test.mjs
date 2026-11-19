// AC16: the reconciler refuses, with a non-zero exit and nothing written, an AI workflow whose allowed-files include a locked rule, source, type or sandbox-test file
// (or any other locked harness or runtime file), and a job-level concurrency that duplicates the workflow-level group.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import YAML from "yaml";
import { checkRendered, renderFleet } from "../../src/reconcile.mjs";
import { createWorkspace } from "../s1/helpers/workspace.mjs";
import { PRESET_ROOT } from "../helpers/preset.mjs";
import { abs, commitAll, git, readText } from "./helpers/fixtures.mjs";
import { manifest as presetOf, parseWorkflow, referenceRequest } from "./helpers/workflows.mjs";

const CONTENT_EDGE = presetOf().dependencyEdges.find((edge) => edge.adaptation?.helpers?.sourceCheck);
const CONTENT_WORKFLOW = `.github/workflows/cascade-ai-${CONTENT_EDGE.edgeId}.md`;
const UNSAFE = [
  ["rules.ts", "content/rules.ts"],
  ["a locked source module", "apps/site/server/src/index.ts"],
  ["types.ts", "content/types.ts"],
  ["sandbox.test.ts", "apps/site/server/tests/sandbox.test.ts"],
  ["another locked harness file", "tests/login.test.ts"],
  ["a glob that reaches rules.ts", "content/*.ts"],
  ["a glob that reaches a locked directory", "kernel/**"],
];

/** A committed preset workspace with one unsafe allowed-files entry on the content edge. */
function workspaceWith(entry) {
  const manifest = structuredClone(presetOf());
  manifest.dependencyEdges.find((edge) => edge.edgeId === CONTENT_EDGE.edgeId).allowedFiles.push(entry);
  const workspace = createWorkspace({ manifestText: YAML.stringify(manifest, { lineWidth: 0 }), instructions: true });
  git(workspace.dir, ["config", "core.autocrlf", "false"]);
  git(workspace.dir, ["config", "commit.gpgsign", "false"]);
  commitAll(workspace.dir, "base");
  return workspace;
}

for (const [label, entry] of UNSAFE) {
  test(`AC16: an allowed-files entry that includes ${label} (${entry}) fails the reconciliation: non-zero exit, no .lock.yml written, an empty git status`, async () => {
    const workspace = workspaceWith(entry);
    try {
      assert.equal(workspace.status(), "", "the workspace starts clean");
      const requestFile = path.join(workspace.root, "request.json");
      fs.writeFileSync(requestFile, JSON.stringify(referenceRequest()));
      const cli = workspace.cli(requestFile);
      assert.notEqual(cli.code, 0, `${cli.stdout}${cli.stderr}`);
      assert.equal(cli.json?.status, "error");
      const errors = cli.json.validationResults.flatMap((result) => result.errors);
      assert.ok(errors.some((error) => /^allowed-files-locked-path: /.test(error) && error.includes(entry)), JSON.stringify(errors));
      assert.deepEqual(workspace.list(".github/workflows").filter((file) => file.endsWith(".lock.yml")), [], "no lock file was written");
      assert.deepEqual(workspace.list(".github/workflows"), [], "nothing was written under .github/workflows");
      assert.equal(workspace.status(), "", "git status --porcelain prints nothing");
      assert.equal((await workspace.reconcile(referenceRequest())).status, "error", "the same through the module");
      assert.equal(workspace.status(), "");
    } finally {
      workspace.cleanup();
    }
  });
}

test("AC16: a job-level concurrency on a custom job that duplicates the workflow-level group is rejected by the check that the reconciler runs on every rendered workflow (no other job-level concurrency is accepted either)", () => {
  const rendered = renderFleet(referenceRequest(), { cwd: PRESET_ROOT });
  assert.ok(rendered.ok);
  const request = referenceRequest();
  const clean = checkRendered(new Map(rendered.files), request, presetOf());
  assert.deepEqual(clean.filter((result) => !result.valid), [], "the rendered preset passes");
  const withConcurrency = (job, concurrency) => {
    const files = new Map(rendered.files);
    const { frontmatter, body } = parseWorkflow(files.get(CONTENT_WORKFLOW));
    frontmatter.jobs[job].concurrency = concurrency;
    files.set(CONTENT_WORKFLOW, `---\n${YAML.stringify(frontmatter, { lineWidth: 0 })}---\n\n${body}`);
    return checkRendered(files, request, presetOf());
  };
  for (const job of ["finalize_poll_state", "escalate_failure"]) {
    const duplicate = withConcurrency(job, { group: `sdlc-state-${CONTENT_EDGE.upstreamKey}` }).find((result) => result.file === CONTENT_WORKFLOW);
    assert.equal(duplicate.valid, false, job);
    assert.ok(duplicate.errors.some((error) => /^job-level-concurrency: /.test(error) && error.includes("duplicates the workflow-level group")), JSON.stringify(duplicate.errors));
  }
  const other = withConcurrency("finalize_poll_state", { group: "something-else" }).find((result) => result.file === CONTENT_WORKFLOW);
  assert.equal(other.valid, false);
  assert.ok(other.errors.some((error) => /^job-level-concurrency: /.test(error)));
  assert.equal(readText(abs(CONTENT_WORKFLOW)).includes("concurrency: {"), false, "the committed workflow has none in a job");
});
