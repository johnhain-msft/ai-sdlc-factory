// The factory install must not leave credentials behind (design section C.3): the token reaches git only through the environment of the one install step,
// never through a persisted checkout credential, a git config file or a `run` script, and every checkout that this renderer writes opts out of persisting
// the credentials of the workflow.

import assert from "node:assert/strict";
import test from "node:test";
import { routerOf, routerSteps, stepsOf, workflowsOf } from "./helpers/rendered.mjs";
import { renderFleet } from "../src/reconcile.mjs";
import { createWorkspace, referenceRequest } from "./helpers/mini-fleet.mjs";

const VARIANTS = {
  "no factory block": undefined,
  "private factory": { package: "ai-sdlc-factory", source: "github:example-org/ai-sdlc-factory", private: true },
  "public factory": { package: "ai-sdlc-factory", private: false },
};

function render(t, block) {
  const work = createWorkspace(t, {
    mutate: (manifest) => {
      if (block !== undefined) manifest.factory = structuredClone(block);
    },
  });
  const result = renderFleet(referenceRequest(), { cwd: work.dir });
  assert.equal(result.ok, true, JSON.stringify(result.result));
  return result.files;
}

/** Every step of every rendered workflow: `{ file, where, index, step }`. */
function everyStep(files) {
  const found = [];
  for (const workflow of workflowsOf(files)) for (const entry of stepsOf(workflow.fm)) found.push({ file: workflow.file, ...entry });
  for (const entry of routerSteps(routerOf(files))) found.push({ file: ".github/workflows/cascade-router.yml", ...entry });
  return found;
}

for (const [label, block] of Object.entries(VARIANTS)) {
  test(`${label}: every checkout step opts out of persisting the credentials of the workflow`, (t) => {
    const checkouts = everyStep(render(t, block)).filter(({ step }) => typeof step.uses === "string" && step.uses.startsWith("actions/checkout"));
    // the escalation job of 2 drift and 2 implementation workflows, the two custom jobs of 2 cascades, and the router
    assert.equal(checkouts.length, 4 + 4 + 1);
    for (const { file, where, step } of checkouts) assert.equal(step.with?.["persist-credentials"], false, `${file} ${where}`);
  });
}

test("the factory token appears only in the environment of the install step, and nothing writes git configuration", (t) => {
  const files = render(t, VARIANTS["private factory"]);
  const steps = everyStep(files);
  const holders = steps.filter(({ step }) => JSON.stringify(step).includes("factory_token.outputs.token"));
  // one install step in each of: 2 drift + 2 implement escalate jobs, 2 cascades x 2 custom jobs, the router, and the agent jobs of 2 drift, 2 implement and 1 AI cascade
  assert.equal(holders.length, 4 + 4 + 1 + 5);
  for (const { file, where, step } of holders) {
    assert.equal(step.name, "Install the factory", `${file} ${where}`);
    assert.equal(JSON.stringify({ ...step, env: undefined }).includes("factory_token"), false, `${file} ${where}: only env may carry the token`);
    for (const [key, value] of Object.entries(step.env)) {
      if (String(value).includes("factory_token")) assert.match(key, /^GIT_CONFIG_KEY_[0-9]$/, `${file} ${where}: ${key}`);
    }
    assert.equal(step.run, "npm ci --ignore-scripts");
  }
  for (const { file, where, step } of steps) {
    const text = typeof step.run === "string" ? step.run : "";
    assert.doesNotMatch(text, /git\s+config|extraheader|\.gitconfig|credential\.helper|insteadOf/, `${file} ${where} must not write git configuration`);
    assert.equal(JSON.stringify(step.with ?? {}).includes("factory_token"), false, `${file} ${where}: no action input carries the factory token`);
  }
  for (const { text } of workflowsOf(files)) assert.doesNotMatch(text, /http\.extraheader/);
});

test("the factory token step asks for read access to one repository and is never told to skip its revocation", (t) => {
  const files = render(t, VARIANTS["private factory"]);
  const tokens = everyStep(files).filter(({ step }) => step.id === "factory_token");
  assert.equal(tokens.length, 14);
  for (const { file, where, step } of tokens) {
    assert.equal(step.with.repositories, "ai-sdlc-factory", `${file} ${where}`);
    assert.equal(step.with.owner, "example-org");
    assert.equal(step.with["permission-contents"], "read");
    assert.deepEqual(Object.keys(step.with).filter((key) => key.startsWith("permission-")), ["permission-contents"], "no other permission");
    assert.equal("skip-token-revoke" in step.with, false);
  }
});
