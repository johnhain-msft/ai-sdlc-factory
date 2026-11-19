#!/usr/bin/env node
// A classifier for the report of `npm run check:inputs -- <checkout>` (design E2): the router runs it right after the check, with the report in a file.
//
//   SDLC_PREFLIGHT_STDOUT_FILE   the standard output of the check
//   SDLC_PREFLIGHT_EXIT_CODE     the exit code of the check
//
// The check prints one summary line, `Inputs checked: <n>; changed <c>, new <n>, gone <g>`, and a ` PROBLEM ...` line for each problem that it found, and it exits
// 1 whenever the commit that it ran against differs from the recorded one, whatever the inputs say. Its exit code cannot tell drift from no drift, so this script
// reads the report and its own exit code is the verdict:
//
//   exit 0  no drift: nothing changed, nothing is new or gone, and the report names no problem
//   exit 1  drift
//   exit 2  the report cannot be judged: the check crashed (an exit code other than 0 or 1), or the summary line is missing or appears twice

import { resolveIo, runAsMain } from "ai-sdlc-factory/script-kit";

const SUMMARY = /^Inputs checked: (\d+); changed (\d+), new (\d+), gone (\d+)\s*$/;
const PROBLEM = /^\s*PROBLEM\b/;

export async function run(argv, ioInput = {}) {
  const io = resolveIo(ioInput);
  const file = io.env.SDLC_PREFLIGHT_STDOUT_FILE;
  const exitCode = io.env.SDLC_PREFLIGHT_EXIT_CODE;
  if (!file || exitCode === undefined) {
    io.stderr("classify-report: SDLC_PREFLIGHT_STDOUT_FILE and SDLC_PREFLIGHT_EXIT_CODE are set by the router for a classifier\n");
    return 2;
  }
  if (exitCode !== "0" && exitCode !== "1") {
    io.stderr(`classify-report: the check exited with ${exitCode}, which is neither no drift nor drift\n`);
    return 2;
  }
  const lines = io.fs.readFileSync(file, "utf8").split(/\r?\n/);
  const summaries = lines.map((line) => SUMMARY.exec(line)).filter((match) => match !== null);
  if (summaries.length !== 1) {
    io.stderr(`classify-report: the report has ${summaries.length === 0 ? "no" : summaries.length} summary line${summaries.length === 1 ? "" : "s"}, so it cannot be judged\n`);
    return 2;
  }
  const [, , changed, added, gone] = summaries[0].map(Number);
  const problems = lines.filter((line) => PROBLEM.test(line)).length;
  const drift = changed + added + gone + problems > 0;
  io.stdout(`classify-report: changed ${changed}, new ${added}, gone ${gone}, problems ${problems}: ${drift ? "drift" : "no drift"}\n`);
  return drift ? 1 : 0;
}

await runAsMain(import.meta.url, run);
