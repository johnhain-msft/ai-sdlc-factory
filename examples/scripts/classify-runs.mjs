#!/usr/bin/env node
// A classifier for the listing of the upstream's workflow runs (design E2, the "snapshot" shape): the router runs it right after
// `gh api "repos/<owner>/<repository>/actions/runs?per_page=100"`, with the listing in a file, from the downstream checkout.
//
//   SDLC_PREFLIGHT_STDOUT_FILE   the standard output of the check: the JSON listing
//   SDLC_PREFLIGHT_EXIT_CODE     the exit code of the check
//
// The downstream records the newest completed run of each workflow that its pages show in content/pipelines/runs.json: { "runs": { "<workflow>": <run id> } }.
// The listing is a drift when a workflow has a newer completed run than the one that is recorded, or one that is not recorded at all; otherwise the upstream
// moved but its runs did not, which the edge declares as noop-unchanged-snapshot.
//
//   exit 0  the snapshot is unchanged
//   exit 1  drift
//   exit 2  it cannot be judged: the check failed, the listing is not the JSON of a run list, or the snapshot is missing or unreadable

import path from "node:path";
import { resolveIo, runAsMain } from "ai-sdlc-factory/script-kit";

const SNAPSHOT = "content/pipelines/runs.json";

/** The newest completed run of each workflow, by name. */
function newestRuns(listing) {
  const newest = {};
  for (const run of listing.workflow_runs) {
    if (run?.status !== "completed" || typeof run.name !== "string" || !Number.isInteger(run.id)) continue;
    if (newest[run.name] === undefined || run.id > newest[run.name]) newest[run.name] = run.id;
  }
  return newest;
}

export async function run(argv, ioInput = {}) {
  const io = resolveIo(ioInput);
  const file = io.env.SDLC_PREFLIGHT_STDOUT_FILE;
  if (!file || io.env.SDLC_PREFLIGHT_EXIT_CODE !== "0") {
    io.stderr(`classify-runs: the listing cannot be judged: the check exited with ${io.env.SDLC_PREFLIGHT_EXIT_CODE ?? "no exit code"}\n`);
    return 2;
  }
  let listing;
  let recorded;
  try {
    listing = JSON.parse(io.fs.readFileSync(file, "utf8"));
    if (!Array.isArray(listing?.workflow_runs)) throw new Error("it has no workflow_runs list");
  } catch (error) {
    io.stderr(`classify-runs: the listing is not the JSON of a run list: ${error.message}\n`);
    return 2;
  }
  try {
    recorded = JSON.parse(io.fs.readFileSync(path.join(io.cwd, ...SNAPSHOT.split("/")), "utf8")).runs;
    if (recorded === null || typeof recorded !== "object" || Array.isArray(recorded)) throw new Error('it has no "runs" mapping');
  } catch (error) {
    io.stderr(`classify-runs: ${SNAPSHOT} cannot be read: ${error.message}\n`);
    return 2;
  }
  const newer = Object.entries(newestRuns(listing)).filter(([workflow, id]) => recorded[workflow] === undefined || id > recorded[workflow]);
  io.stdout(`classify-runs: ${newer.length === 0 ? "the snapshot is unchanged" : `newer runs: ${newer.map(([workflow, id]) => `${workflow} (${id})`).join(", ")}`}\n`);
  return newer.length === 0 ? 0 : 1;
}

await runAsMain(import.meta.url, run);
