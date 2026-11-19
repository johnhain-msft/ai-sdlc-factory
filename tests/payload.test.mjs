// The onboarding workflow that the package ships: payload/workflows/sdlc-onboard.md, installed into an orchestrator by aw.yml. It is the output of the
// renderer for a fleet that has no GitHub App yet, never a hand-written file, and the next `sdlc-reconcile` of an orchestrator overwrites its copy with the real
// App slug. The renderer's own properties (determinism, equality with a fleet's workflow up to the bots entry) are pinned in tests/onboard-payload.test.mjs;
// these tests pin the committed file and the tool that regenerates it.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import YAML from "yaml";
import { parseOnboardArgs } from "../bin/lib/cli-flags.mjs";
import { checkRendered, renderOnboardPayload } from "../src/reconcile.mjs";
import { main as updatePayload, PAYLOAD_FILE } from "../tools/update-payload.mjs";
import { miniManifest, referenceRequest } from "./helpers/mini-fleet.mjs";
import { assertGhAwAtLeast, compileStrict, SKIP_REAL_GH_AW } from "./helpers/real-gh-aw.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const COMMITTED = path.join(ROOT, ...PAYLOAD_FILE.split("/"));
const INSTALLED_AS = ".github/workflows/sdlc-onboard.md";
const ACTIONS_LOCK = fs.readFileSync(path.join(ROOT, "tests", "fixtures", "actions-lock.json"), "utf8");

const committed = () => fs.readFileSync(COMMITTED, "utf8");
const frontmatter = (text) => YAML.parse(/^---\n([\s\S]*?)\n---\n/.exec(text)[1]);

function capture() {
  const sink = { out: "", err: "" };
  return { sink, io: { stdout: { write: (text) => (sink.out += text) }, stderr: { write: (text) => (sink.err += text) } } };
}

function tempRoot(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sdlc-payload-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test("the committed payload is what renderOnboardPayload() produces, byte for byte", () => {
  assert.equal(committed(), renderOnboardPayload(), "regenerate it with: node tools/update-payload.mjs");
});

test("the payload names no GitHub App: no on.bots key and no [bot] literal", () => {
  const text = committed();
  assert.deepEqual(Object.keys(frontmatter(text).on), ["workflow_dispatch"]);
  assert.doesNotMatch(text, /\[bot\]/);
  assert.doesNotMatch(text, /^\s*bots:/m);
});

test("the payload is LF text that starts with its front matter and ends in one newline", () => {
  const text = committed();
  assert.ok(!text.includes("\r"), "no carriage return");
  assert.ok(text.startsWith("---\n"));
  assert.ok(text.endsWith("\n") && !text.endsWith("\n\n"));
});

test("checkRendered finds nothing to object to in the committed payload, and it does not require a bots entry", () => {
  const request = referenceRequest({ appSlug: "example-orchestrator", engineAuthMode: "copilot-requests" });
  const manifest = { ...miniManifest(), factory: { package: "ai-sdlc-factory" } };
  assert.deepEqual(checkRendered(new Map([[INSTALLED_AS, committed()]]), request, manifest), [{ file: INSTALLED_AS, valid: true, errors: [] }]);
});

test("checkRendered does object when the payload enables auto-merge, so the check above is not vacuous", () => {
  const request = referenceRequest({ appSlug: "example-orchestrator", engineAuthMode: "copilot-requests" });
  const manifest = { ...miniManifest(), factory: { package: "ai-sdlc-factory" } };
  const [result] = checkRendered(new Map([[INSTALLED_AS, committed().replace("auto-merge: false", "auto-merge: true")]]), request, manifest);
  assert.equal(result.valid, false);
  assert.ok(result.errors.length > 0);
});

test("the command that the payload's prompt names is the one the package installs, and every flag it lists is accepted", () => {
  const prompt = committed().split("\n---\n").slice(1).join("\n---\n");
  assert.ok(prompt.includes("node node_modules/ai-sdlc-factory/bin/sdlc-onboard.mjs --repo <repo>"));
  assert.ok(fs.existsSync(path.join(ROOT, "bin", "sdlc-onboard.mjs")));
  const flags = ["--downstream", "--strategy", "--watch-url", "--schedule", "--mode", "--instructions", "--manifest"];
  for (const flag of flags) assert.ok(prompt.includes(`\`${flag}\``), `the prompt lists ${flag}`);
  const parsed = parseOnboardArgs([
    "--repo", "example-org/repo", "--downstream", "example-org/hub", "--strategy", "custom", "--watch-url", "https://example.org/changelog",
    "--schedule", "15 4 * * 2", "--mode", "mechanical", "--instructions", "keep it current", "--manifest", "sdlc.yaml",
  ]);
  assert.equal(parsed.repo, "example-org/repo");
});

test("tools/update-payload.mjs writes the file when it is missing, leaves it alone when it is current and rewrites it when it is stale", (t) => {
  const root = tempRoot(t);
  const target = path.join(root, ...PAYLOAD_FILE.split("/"));
  const first = capture();
  assert.equal(updatePayload([], { root, render: () => "one\n", ...first.io }), 0);
  assert.equal(fs.readFileSync(target, "utf8"), "one\n");
  assert.equal(first.sink.out, `wrote ${PAYLOAD_FILE}\n`);

  const second = capture();
  assert.equal(updatePayload([], { root, render: () => "one\n", ...second.io }), 0);
  assert.equal(second.sink.out, `${PAYLOAD_FILE} is up to date\n`);

  const third = capture();
  assert.equal(updatePayload([], { root, render: () => "two\n", ...third.io }), 0);
  assert.equal(fs.readFileSync(target, "utf8"), "two\n");
});

test("tools/update-payload.mjs --check exits 1 without writing when the file is missing or stale, and 0 when it is current", (t) => {
  const root = tempRoot(t);
  const target = path.join(root, ...PAYLOAD_FILE.split("/"));
  const missing = capture();
  assert.equal(updatePayload(["--check"], { root, render: () => "one\n", ...missing.io }), 1);
  assert.ok(!fs.existsSync(target), "--check never writes");
  assert.match(missing.sink.err, /is not what the renderer produces: run node tools\/update-payload\.mjs/);

  updatePayload([], { root, render: () => "one\n", ...capture().io });
  const stale = capture();
  assert.equal(updatePayload(["--check"], { root, render: () => "two\n", ...stale.io }), 1);
  assert.equal(fs.readFileSync(target, "utf8"), "one\n", "a stale file is left as it was");

  const current = capture();
  assert.equal(updatePayload(["--check"], { root, render: () => "one\n", ...current.io }), 0);
  assert.equal(current.sink.out, `${PAYLOAD_FILE} is what the renderer produces\n`);
});

test("tools/update-payload.mjs refuses an argument it does not know, and as a command exits 0 on the committed file", () => {
  for (const argv of [["--bogus"], ["--check", "--check"], ["--check", "x"], ["x"]]) {
    const refused = capture();
    assert.equal(updatePayload(argv, { render: () => "x\n", ...refused.io }), 2, argv.join(" "));
    assert.match(refused.sink.err, /^usage: node tools\/update-payload\.mjs \[--check\]\n$/);
  }
  const run = spawnSync(process.execPath, [path.join(ROOT, "tools", "update-payload.mjs"), "--check"], { cwd: ROOT, encoding: "utf8" });
  assert.equal(run.status, 0, `${run.stdout}${run.stderr}`);
  assert.match(run.stdout, /is what the renderer produces/);
});

test("the committed payload compiles under the real gh-aw in strict mode, with no bot in it", { skip: SKIP_REAL_GH_AW }, (t) => {
  assertGhAwAtLeast("1.0.1");
  const outcome = compileStrict(t, new Map([[INSTALLED_AS, committed()]]), { actionsLock: ACTIONS_LOCK });
  assert.equal(outcome.results.length, 1, outcome.stderr);
  assert.deepEqual(outcome.results.filter((entry) => entry.valid !== true), []);
  assert.equal(outcome.code, 0, outcome.stderr);
});
