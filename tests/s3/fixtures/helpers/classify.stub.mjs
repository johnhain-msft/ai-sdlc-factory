// A hermetic stand-in for the classifier of a declared preflight check (design section E2): a command that the router runs, once per check that names it, in the
// directory of the check, after the check's own command. What decides is its exit code: 0 no drift, 1 drift, anything else a failure. It exists only inside the
// fixtures of the router's tests.
//
// It answers what classify.stub.json beside it says ({ code } for every call, or { codes: [..] } indexed by SDLC_PREFLIGHT_INDEX; stderr is printed) and appends
// what the router handed it (the variables of the contract and the content of the two files they name) to classify.log.jsonl.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const config = JSON.parse(fs.readFileSync(path.join(here, "classify.stub.json"), "utf8"));
const read = (file) => {
  try {
    return fs.readFileSync(file, "utf8");
  } catch (error) {
    return `<unreadable: ${error.code ?? error.message}>`;
  }
};
const env = process.env;
fs.appendFileSync(
  path.join(here, "classify.log.jsonl"),
  `${JSON.stringify({
    index: env.SDLC_PREFLIGHT_INDEX ?? null,
    command: env.SDLC_PREFLIGHT_COMMAND ?? null,
    exitCode: env.SDLC_PREFLIGHT_EXIT_CODE ?? null,
    stdoutFile: env.SDLC_PREFLIGHT_STDOUT_FILE ?? null,
    stderrFile: env.SDLC_PREFLIGHT_STDERR_FILE ?? null,
    stdout: env.SDLC_PREFLIGHT_STDOUT_FILE ? read(env.SDLC_PREFLIGHT_STDOUT_FILE) : null,
    stderr: env.SDLC_PREFLIGHT_STDERR_FILE ? read(env.SDLC_PREFLIGHT_STDERR_FILE) : null,
    cwd: process.cwd(),
    upstreamDir: env.UPSTREAM_DIR ?? null,
    targetSha: env.TARGET_SHA ?? null,
    lastMergedSha: env.LAST_MERGED_SHA ?? null,
    manifest: env.SDLC_MANIFEST ?? null,
    secrets: ["APP_PRIVATE_KEY", "ISSUES_TOKEN", "APP_CLIENT_ID"].filter((name) => env[name] !== undefined),
  })}\n`,
);
if (config.stderr) process.stderr.write(config.stderr);
const index = Number(env.SDLC_PREFLIGHT_INDEX);
process.exit(Array.isArray(config.codes) ? (config.codes[index] ?? 0) : (config.code ?? 0));
