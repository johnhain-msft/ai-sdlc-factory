// AC18: the compile acknowledgment AiWorkflowCompileAck that the reconciler reports for the three AI workflows, and its agreement with the rendered post-steps.
import assert from "node:assert/strict";
import test from "node:test";
import { buildAcks } from "../../src/reconcile.mjs";
import { PRESET_ROOT } from "../helpers/preset.mjs";
import { FACTORY_PATH, fillCommand } from "../s1/helpers/factory.mjs";
import { AI, DOWNSTREAM, edgeOf, referenceRequest, workflowOf } from "./helpers/workflows.mjs";

const ack = () => buildAcks(referenceRequest(), { cwd: PRESET_ROOT }).ai;
const ZERO_DIFF = [...new Set(AI.flatMap((spec) => edgeOf(spec).immutableGates.zeroDiffPaths))].sort();
const downstream = DOWNSTREAM.split("/")[1];
const gateCommands = (spec) => edgeOf(spec).verifyCommands.filter((command) => !command.trimStart().startsWith("#"));
const GATE = [
  'BASE_SHA="$(cat /tmp/gh-aw/base-sha.txt)"',
  `AGENT_HEAD_SHA="$(git -C "$GITHUB_WORKSPACE/${downstream}" rev-parse HEAD)"`,
  `node --frozen-intrinsics "${FACTORY_PATH}/src/verify-immutable-gates.mjs" --downstream "$GITHUB_WORKSPACE/${downstream}" --base "$BASE_SHA" --workflow <workflow-id>`,
  ...gateCommands(AI[0]),
];

test("AC18: the acknowledgment has exactly the five members, and the workflow ids and lock paths are those of the three workflows, in order", () => {
  const value = ack();
  assert.deepEqual(Object.keys(value).sort(), ["allowedFilesByWorkflow", "immutableProtectedPaths", "lockPaths", "verificationGate", "workflowIds"]);
  assert.deepEqual(value.workflowIds, AI.map((spec) => spec.id));
  assert.deepEqual(value.lockPaths, AI.map((spec) => `.github/workflows/${spec.id}.lock.yml`));
});

test("AC18: allowedFilesByWorkflow maps each workflow to the exact list that its safe output carries", () => {
  const value = ack();
  assert.deepEqual(Object.keys(value.allowedFilesByWorkflow), value.workflowIds);
  for (const spec of AI) {
    assert.deepEqual(value.allowedFilesByWorkflow[spec.id], edgeOf(spec).allowedFiles, spec.id);
    assert.deepEqual(value.allowedFilesByWorkflow[spec.id], workflowOf(spec).frontmatter["safe-outputs"]["create-pull-request"]["allowed-files"], `${spec.id}: the rendered workflow`);
  }
  for (const spec of AI) assert.equal(value.allowedFilesByWorkflow[spec.id].length, edgeOf(spec).allowedFiles.length);
});

test("AC18: immutableProtectedPaths are the union of the declared zero-diff paths, sorted", () => {
  const { immutableProtectedPaths } = ack();
  assert.equal(immutableProtectedPaths.length, ZERO_DIFF.length);
  assert.deepEqual(immutableProtectedPaths, [...ZERO_DIFF].sort());
});

test("AC18: verificationGate is the ordered list of command templates of the first AI edge, with <workflow-id> as the only per-workflow variable", () => {
  const { verificationGate } = ack();
  assert.deepEqual(verificationGate, GATE);
  assert.equal(verificationGate.length, 3 + gateCommands(AI[0]).length);
  for (const hand of ["GITHUB_ENV", "upload-artifact", "cascade-shas.json", "AGENT_HEAD_SHA=$AGENT_HEAD_SHA"]) {
    assert.equal(verificationGate.some((template) => template.includes(hand) && !template.startsWith("AGENT_HEAD_SHA=")), false, `${hand} is not a member of the gate`);
  }
  assert.equal(verificationGate.filter((template) => template.includes("<")).length, 1, "only the helper names the workflow");
});

test("AC18: each workflow runs the hand-off templates, the helper with its own id and all its declared verification commands", () => {
  for (const spec of AI) {
    const steps = workflowOf(spec).frontmatter["post-steps"];
    const [handOff, upload, helper, ...commands] = steps;
    assert.ok(handOff.run.includes(GATE[0]) && handOff.run.includes(GATE[1]), `${spec.id}: the first step records both revisions`);
    assert.ok(handOff.run.includes('/tmp/gh-aw/cascade-shas.json') && handOff.run.includes('>> "$GITHUB_ENV"'), spec.id);
    assert.equal(upload.uses, "actions/upload-artifact@v4", spec.id);
    assert.equal(upload.with.name, "sdlc-cascade-shas-${{ github.run_id }}", spec.id);
    assert.equal(helper.run, GATE[2].replace("<workflow-id>", spec.id), `${spec.id}: the helper`);
    edgeOf(spec).verifyCommands.forEach((command, index) => {
      const run = commands[index].run;
      if (!command.trimStart().startsWith("#") && command.includes("status --porcelain")) {
        // a status command is rendered as the clean-tree check that fails when it prints anything
        assert.ok(run.includes(command) && run.includes("exit 1"), `${spec.id}: the clean-tree check`);
      } else {
        assert.equal(run.trim(), fillCommand(command).trim(), `${spec.id}: command ${index + 1}`);
      }
    });
    assert.equal(commands.length, edgeOf(spec).verifyCommands.length, `${spec.id}: followed by the post-run checks`);
  }
});
