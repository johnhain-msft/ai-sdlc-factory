// Compiling rendered workflows with the real gh-aw (`gh aw compile --strict`), for the tests that run under SDLC_REAL_GH_AW=1.
//
// The compiler is the one `gh` finds: set SDLC_GH_AW_DATA_HOME to the data home of an isolated gh-aw install when the global extension is older than
// v1.0.1 (the renderer's own ghAwEnvironment applies it as XDG_DATA_HOME). Nothing here touches the repository under test: every compile runs in a
// scratch git repository that holds the rendered files and the pinned action versions.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ghAwEnvironment } from "../../src/reconcile.mjs";

export const REAL_GH_AW = process.env.SDLC_REAL_GH_AW === "1";
export const SKIP_REAL_GH_AW = REAL_GH_AW ? false : "set SDLC_REAL_GH_AW=1 (and SDLC_GH_AW_DATA_HOME for an isolated gh-aw >= 1.0.1) to compile with the real gh-aw";

const environment = () => ghAwEnvironment({ ...process.env, GIT_TERMINAL_PROMPT: "0", GH_PROMPT_DISABLED: "1" });

/**
 * The repository config that gh-aw v1.0.1 accepts. The renderer's aw.json (and so the one in the preset) carries `protected_files`, which that release refuses
 * (SPEC-01 AC55); the reconciler compiles with this strict-only file after the first refusal, and a test that hands a copy of the preset to the compiler itself
 * has to do the same before it compiles. Every release accepts it.
 */
export const STRICT_ONLY_AW_JSON = `${JSON.stringify({ strict: true }, null, 2)}\n`;

/** Puts the strict-only repository config where the compiler reads it, in the copy of a repository under `root`. */
export function useStrictOnlyAwJson(root) {
  fs.writeFileSync(path.join(root, ".github", "workflows", "aw.json"), STRICT_ONLY_AW_JSON);
}

/** The version of the gh-aw that `gh aw` runs, e.g. "1.0.1"; the tests that compile need at least 1.0.1. */
export function ghAwVersion() {
  const run = spawnSync("gh", ["aw", "version"], { env: environment(), encoding: "utf8", windowsHide: true, timeout: 60000 });
  const match = /v?(\d+\.\d+\.\d+)/.exec(`${run.stdout}${run.stderr}`);
  return match ? match[1] : null;
}

export function assertGhAwAtLeast(minimum = "1.0.1") {
  const found = ghAwVersion();
  assert.ok(found !== null, "gh aw is not installed or does not answer `gh aw version`");
  const [a, b] = [found, minimum].map((text) => text.split(".").map(Number));
  const older = a[0] < b[0] || (a[0] === b[0] && (a[1] < b[1] || (a[1] === b[1] && a[2] < b[2])));
  assert.equal(older, false, `gh aw ${found} is older than ${minimum}: point SDLC_GH_AW_DATA_HOME at an isolated install of ${minimum} or later`);
  return found;
}

/**
 * Compiles `files` (a Map of repository-relative path to text) with `gh aw compile --strict --no-emit --json` in a scratch repository.
 * @returns {{ code: number | null, results: { workflow: string, valid: boolean, errors: string[] }[], stdout: string, stderr: string }}
 */
export function compileStrict(t, files, { actionsLock }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sdlc-ghaw-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const env = environment();
  const git = spawnSync("git", ["init", "-q"], { cwd: dir, env, windowsHide: true });
  assert.equal(git.status, 0, "git init failed in the scratch repository");
  const put = (relative, text) => {
    const target = path.join(dir, ...relative.split("/"));
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, text);
  };
  for (const [relative, text] of files) put(relative, text);
  put(".github/workflows/aw.json", STRICT_ONLY_AW_JSON);
  put(".github/aw/actions-lock.json", actionsLock);
  const run = spawnSync("gh", ["aw", "compile", "--strict", "--no-emit", "--json"], { cwd: dir, env, encoding: "utf8", windowsHide: true, timeout: 600000 });
  let results = [];
  const text = String(run.stdout).trim();
  try {
    results = JSON.parse(text);
  } catch {
    const start = text.search(/^\[/m);
    if (start !== -1) results = JSON.parse(text.slice(start));
  }
  return {
    code: run.status,
    results: (Array.isArray(results) ? results : []).map((entry) => ({ ...entry, errors: (entry.errors ?? []).map((error) => (typeof error === "string" ? error : error?.message ?? JSON.stringify(error))) })),
    stdout: run.stdout,
    stderr: run.stderr,
  };
}
