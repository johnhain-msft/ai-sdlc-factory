// The onboarding workflow that the engine ships without an App (design J.2): renderOnboardPayload() is renderOnboard with a context that has no bot.
// With a real App slug the render of a fleet is what it always was, so the payload differs from it in the one entry that the slug fills in.
import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { checkRendered, renderFleet, renderOnboardPayload } from "../src/reconcile.mjs";
import { assertGhAwAtLeast, compileStrict, SKIP_REAL_GH_AW } from "./helpers/real-gh-aw.mjs";
import { bodyOf, frontmatterOf } from "./helpers/rendered.mjs";
import { createWorkspace, referenceRequest } from "./helpers/mini-fleet.mjs";

const ONBOARD = ".github/workflows/sdlc-onboard.md";
const ACTIONS_LOCK = fs.readFileSync(fileURLToPath(new URL("./fixtures/actions-lock.json", import.meta.url)), "utf8");

function fleetOnboard(t, slug) {
  const work = createWorkspace(t, { mutate: (manifest) => (manifest.factory = { package: "ai-sdlc-factory" }), files: { "package.json": JSON.stringify({ name: "x", dependencies: { "ai-sdlc-factory": "1.0.0" } }) } });
  const request = referenceRequest({ appSlug: slug, engineAuthMode: "copilot-requests" });
  const result = renderFleet(request, { cwd: work.dir });
  assert.equal(result.ok, true, JSON.stringify(result.result));
  return { text: result.files.get(ONBOARD), request, manifest: work.manifest };
}

test("the payload has no bot: no on.bots key and no [bot] literal anywhere", () => {
  const payload = renderOnboardPayload();
  const frontmatter = frontmatterOf(payload);
  assert.deepEqual(Object.keys(frontmatter.on), ["workflow_dispatch"]);
  assert.doesNotMatch(payload, /\[bot\]/);
  assert.doesNotMatch(payload, /bots:/);
  assert.match(payload, /^---\n/);
});

test("with a real slug the onboarding workflow of a fleet is the payload plus the bots entry, and nothing else differs", (t) => {
  const payload = renderOnboardPayload();
  const fleet = fleetOnboard(t, "example-orchestrator").text;
  const withBot = frontmatterOf(fleet);
  assert.deepEqual(withBot.on.bots, ["example-orchestrator[bot]"]);
  assert.deepEqual(Object.keys(withBot.on), ["workflow_dispatch", "bots"], "the entry comes after workflow_dispatch");
  const { bots, ...rest } = withBot.on;
  assert.deepEqual({ ...withBot, on: rest }, frontmatterOf(payload), "every other key of the frontmatter, in value and in order");
  assert.deepEqual(Object.keys(withBot), Object.keys(frontmatterOf(payload)));
  assert.equal(bodyOf(fleet), bodyOf(payload), "and the prompt is the same text");
  // byte level: the one entry is the only difference
  const stripped = fleet.replace(/^ {2}bots:\n {4}- example-orchestrator\[bot\]\n/m, "");
  assert.equal(stripped, payload);
});

test("the defaults of the payload are the ones that need no secret of the adopter's choosing", () => {
  const frontmatter = frontmatterOf(renderOnboardPayload());
  assert.equal(frontmatter.engine.id, "copilot");
  assert.equal(frontmatter.engine.env, undefined, "no personal access token secret");
  assert.equal(frontmatter.permissions["copilot-requests"], "write");
  assert.deepEqual(frontmatter.checkout[0]["github-app"], { "client-id": "${{ vars.APP_CLIENT_ID }}", "private-key": "${{ secrets.APP_PRIVATE_KEY }}" });
  assert.deepEqual(frontmatter["safe-outputs"]["create-pull-request"]["protected-files"], { policy: "blocked", exclude: [] });
  assert.match(bodyOf(renderOnboardPayload()), /Run `node node_modules\/ai-sdlc-factory\/bin\/sdlc-onboard\.mjs --repo <repo>`/);
});

test("the payload exposes every onboarding input and passes it to the recording step through the environment", () => {
  const frontmatter = frontmatterOf(renderOnboardPayload());
  const inputs = ["repo", "downstream", "strategy", "watch_url", "schedule", "mode", "instructions", "manifest"];
  assert.deepEqual(Object.keys(frontmatter.on.workflow_dispatch.inputs), inputs);
  const recording = frontmatter["pre-agent-steps"].find((step) => step.name === "Record the onboarding inputs");
  assert.deepEqual(recording.env, Object.fromEntries(inputs.map((name) => [`INPUT_${name.toUpperCase()}`, `\${{ inputs.${name} }}`])));
});

test("the render is deterministic, and checkRendered finds nothing to object to in it", (t) => {
  assert.equal(renderOnboardPayload(), renderOnboardPayload());
  const { request, manifest } = fleetOnboard(t, "example-orchestrator");
  const results = checkRendered(new Map([[ONBOARD, renderOnboardPayload()]]), request, manifest);
  assert.deepEqual(results, [{ file: ONBOARD, valid: true, errors: [] }], "the function does not require a bots entry");
});

test("the payload compiles under the real gh-aw in strict mode, with no bot in it", { skip: SKIP_REAL_GH_AW }, (t) => {
  assertGhAwAtLeast("1.0.1");
  const outcome = compileStrict(t, new Map([[ONBOARD, renderOnboardPayload()]]), { actionsLock: ACTIONS_LOCK });
  assert.equal(outcome.results.length, 1, outcome.stderr);
  assert.deepEqual(outcome.results.filter((entry) => entry.valid !== true), []);
  assert.equal(outcome.code, 0, outcome.stderr);
});
