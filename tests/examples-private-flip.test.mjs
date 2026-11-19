// factory.private: false is a real no-op (design C.7). Flipping the flag of the reference fleet removes the token step and the name and environment of the install
// step in every place that installs the factory, and nothing else: the public form of the step is the plain `npm ci --ignore-scripts`. p3's factory-dir test proves
// this on a small fleet; this one proves it on all fifteen files of examples/, where the install sites are in the router, the plain jobs and the agent jobs.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { isDeepStrictEqual } from "node:util";
import YAML from "yaml";
import { renderFleet } from "../src/reconcile.mjs";
import { engineAbs } from "./helpers/preset.mjs";
import { bodyOf, frontmatterOf, routerOf, workflowsOf } from "./helpers/rendered.mjs";

const W = ".github/workflows";
const INSTALL_PUBLIC = { run: "npm ci --ignore-scripts" };
// 3 AI cascades x 3 + 3 mechanical cascades x 2 + the router + 3 drift x 2 + 3 implement x 2; the onboarding workflow installs nothing.
const PLACES = 28;

const read = (...parts) => fs.readFileSync(engineAbs("examples", ...parts), "utf8");
const request = JSON.parse(read("request.reference.json"));

/** Renders examples/ with factory.private set to `privateFlag`, in a scratch directory that is removed again. */
function render(privateFlag) {
  const manifest = YAML.parse(read("sdlc.yaml"));
  manifest.factory.private = privateFlag;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sdlc-private-flip-"));
  try {
    fs.writeFileSync(path.join(dir, "sdlc.yaml"), YAML.stringify(manifest, { lineWidth: 0 }));
    fs.cpSync(engineAbs("examples", "instructions"), path.join(dir, "instructions"), { recursive: true });
    fs.copyFileSync(engineAbs("examples", "package.json"), path.join(dir, "package.json"));
    const result = renderFleet(request, { cwd: dir });
    assert.equal(result.ok, true, JSON.stringify(result.result));
    return result.files;
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// Rendered on first use, so that a render the factory refuses is a failing test with its message and not a crash of the whole file.
let fleets;
const fleet = () => (fleets ??= { privateFiles: render(true), publicFiles: render(false) });

/** The parsed documents of the files that hold steps: the frontmatter of each workflow source, and the router. */
const documentsOf = (files) => [...workflowsOf(files).map((workflow) => workflow.fm), routerOf(files)];

function* arraysOf(value) {
  if (Array.isArray(value)) {
    yield value;
    for (const item of value) yield* arraysOf(item);
  } else if (value !== null && typeof value === "object") {
    for (const item of Object.values(value)) yield* arraysOf(item);
  }
}
const stepArrays = (files) => documentsOf(files).flatMap((document) => [...arraysOf(document)]);

/** What the flip removes, applied to a private document: the token steps go, the install steps become the plain one. */
function withoutAuth(value) {
  if (Array.isArray(value)) return value.filter((step) => step?.id !== "factory_token").map((step) => (step?.name === "Install the factory" ? structuredClone(INSTALL_PUBLIC) : withoutAuth(step)));
  if (value !== null && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, withoutAuth(item)]));
  return value;
}

test("the private reference fleet installs the factory in twenty-eight places: each mints the token and installs with the three rewrites", () => {
  const { privateFiles } = fleet();
  const sites = stepArrays(privateFiles).flatMap((steps) => steps.flatMap((step, index) => (step?.id === "factory_token" ? [{ step, next: steps[index + 1] }] : [])));
  assert.equal(sites.length, PLACES);
  for (const { step, next } of sites) {
    assert.deepEqual(step.with, { "app-id": "${{ vars.APP_CLIENT_ID }}", "private-key": "${{ secrets.APP_PRIVATE_KEY }}", owner: "example-org", repositories: "ai-sdlc-factory", "permission-contents": "read" });
    assert.equal(next?.name, "Install the factory", "the install step follows the token step");
    assert.equal(next.run, "npm ci --ignore-scripts");
    assert.equal(next.env.GIT_CONFIG_COUNT, "3");
    assert.equal(Object.keys(next.env).filter((key) => key.startsWith("GIT_CONFIG_VALUE_")).length, 3);
  }
});

test("the public reference fleet installs it in the same twenty-eight places, each the plain npm ci and nothing more", () => {
  const { privateFiles, publicFiles } = fleet();
  const plain = stepArrays(publicFiles).flatMap((steps) => steps.filter((step) => isDeepStrictEqual(step, INSTALL_PUBLIC)));
  assert.equal(plain.length, PLACES);
  for (const steps of stepArrays(publicFiles)) {
    assert.equal(steps.some((step) => step?.id === "factory_token" || step?.name === "Install the factory"), false);
  }
  // the install of the target's own dependencies for the drift agent's sandbox is a different step: it has a name and a directory, and the flip leaves it alone
  const targetInstalls = (files) => stepArrays(files).flatMap((steps) => steps.filter((step) => step?.name === "Install target checkout dependencies for in-sandbox validation"));
  assert.equal(targetInstalls(publicFiles).length, 2, "docs-site's drift and implement workflows");
  assert.deepEqual(targetInstalls(publicFiles), targetInstalls(privateFiles));
  for (const [file, text] of publicFiles) for (const word of ["GIT_CONFIG_", "x-access-token", "factory_token"]) assert.equal(text.includes(word), false, `${file} still has ${word}`);
});

test("public is private minus the auth in every file: the same files, the same prompts, and the same documents once the token steps and the install blocks are taken out", () => {
  const { privateFiles, publicFiles } = fleet();
  assert.deepEqual([...publicFiles.keys()], [...privateFiles.keys()]);
  for (const workflow of workflowsOf(privateFiles)) {
    const other = publicFiles.get(workflow.file);
    assert.deepEqual(frontmatterOf(other), withoutAuth(workflow.fm), `${workflow.file}: public is private minus the auth`);
    assert.equal(bodyOf(other), bodyOf(workflow.text), `${workflow.file}: the prompt does not change`);
  }
  assert.deepEqual(routerOf(publicFiles), withoutAuth(routerOf(privateFiles)));
  assert.equal(publicFiles.get(`${W}/aw.json`), privateFiles.get(`${W}/aw.json`));
  assert.equal(publicFiles.get(`${W}/sdlc-onboard.md`), privateFiles.get(`${W}/sdlc-onboard.md`), "a workflow with no install site does not change at all");
});

test("flipping back restores the committed render byte for byte, so the render depends on the data of the manifest and not on how it is written", () => {
  const { privateFiles } = fleet();
  for (const [file, text] of privateFiles) assert.equal(read(file), text, `${file}: regenerate with node tools/update-examples.mjs --compile`);
});

test("the committed locks have the private form exactly where their sources have it", () => {
  const { privateFiles } = fleet();
  for (const workflow of workflowsOf(privateFiles)) {
    const lock = read(workflow.file.replace(/\.md$/, ".lock.yml"));
    const hasInstall = workflow.text.includes("Install the factory");
    assert.equal(lock.includes('GIT_CONFIG_COUNT: "3"'), hasInstall, `${workflow.file}: the compiled lock and the source agree on the git rewrites`);
    assert.equal(lock.includes("steps.factory_token.outputs.token"), hasInstall, `${workflow.file}: ... and on the token`);
  }
});
