// The `sdlc-reconcile` command and the `./reconcile` export of the package (design sections A.7 and L.1): the binary is a thin wrapper around the exported
// main() of src/reconcile.mjs, so an instance that depends on the package runs `npx sdlc-reconcile --request <file>`.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createWorkspace, referenceRequest } from "./helpers/mini-fleet.mjs";

const ENGINE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const BIN = path.join(ENGINE_ROOT, "bin", "sdlc-reconcile.mjs");
const PACKAGE = JSON.parse(fs.readFileSync(path.join(ENGINE_ROOT, "package.json"), "utf8"));

function runBin(cwd, args) {
  const outcome = spawnSync(process.execPath, [BIN, ...args], { cwd, encoding: "utf8", windowsHide: true, timeout: 120000 });
  return { code: outcome.status, stdout: outcome.stdout, stderr: outcome.stderr };
}

test("package.json declares the sdlc-reconcile binary and the ./reconcile export", () => {
  assert.equal(PACKAGE.bin["sdlc-reconcile"], "bin/sdlc-reconcile.mjs");
  assert.equal(PACKAGE.exports["./reconcile"], "./src/reconcile-api.mjs", "the export is the four public names, not the implementation module that the binary imports");
  assert.ok(fs.existsSync(BIN));
  assert.ok(PACKAGE.files.includes("bin") && PACKAGE.files.includes("src"));
});

test("sdlc-reconcile --help prints the usage and exits 0", (t) => {
  const work = createWorkspace(t);
  const help = runBin(work.dir, ["--help"]);
  assert.equal(help.code, 0, help.stderr);
  assert.match(help.stdout, /sdlc-reconcile --request <file>/);
  assert.equal(runBin(work.dir, ["-h"]).code, 0);
});

test("sdlc-reconcile prints a ReconcileResult as JSON and exits 1 for a request that is refused, without writing a file", (t) => {
  const work = createWorkspace(t);
  const before = fs.readdirSync(work.dir).sort();
  const none = runBin(work.dir, []);
  assert.equal(none.code, 1);
  assert.match(JSON.parse(none.stdout).validationResults[0].errors[0], /^request-missing: usage: /);

  const request = referenceRequest();
  delete request.appSlug;
  work.write("request.json", JSON.stringify(request));
  const bad = runBin(work.dir, ["--request", "request.json"]);
  assert.equal(bad.code, 1, bad.stderr);
  const result = JSON.parse(bad.stdout);
  assert.equal(result.status, "error");
  assert.deepEqual(result.generatedWorkflows, []);
  assert.match(result.validationResults[0].errors.join("\n"), /request-missing-field: field 'appSlug' is required/);

  // a valid request whose manifest is where the working directory says: the failure is the manifest's, so the command did read it from its cwd
  work.write("missing.json", JSON.stringify(referenceRequest({ manifestPath: "nowhere.yaml" })));
  const missing = runBin(work.dir, ["--request", "missing.json"]);
  assert.equal(missing.code, 1);
  assert.match(JSON.parse(missing.stdout).validationResults[0].errors[0], /^manifest-unreadable: nowhere\.yaml cannot be read/);
  assert.deepEqual(fs.readdirSync(work.dir).sort(), [...before, "missing.json", "request.json"].sort(), "nothing but the request files is in the workspace");
});

test("the package is importable by its own name through the ./reconcile export, and the binary's main() is the implementation module's", async () => {
  const reconcile = await import("ai-sdlc-factory/reconcile");
  for (const name of ["renderFleet", "reconcile", "checkRendered", "buildAcks"]) assert.equal(typeof reconcile[name], "function", name);
  assert.equal("main" in reconcile, false, "main() is the binary's, not the package's");
  const implementation = await import("../src/reconcile.mjs");
  assert.equal(typeof implementation.main, "function");
});
