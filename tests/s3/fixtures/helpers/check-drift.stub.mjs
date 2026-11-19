// A hermetic stand-in for a helper CLI that an edge's preflight command runs (a command with its own exit-code contract: 0 no drift, 1 drift, 2 fatal). It exists
// only inside the fixtures of the router's tests; the router never substitutes this file for a missing one.
//
// It answers what check-drift.stub.json beside it says ({ code, stdout, stderr }; an object `stdout` is printed as JSON) and appends how it was called
// to check-drift.log.jsonl, so that a test can see the arguments (and that none of them is --accept) and the SDLC_PREFLIGHT_* variables it did not get.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const config = JSON.parse(fs.readFileSync(path.join(here, "check-drift.stub.json"), "utf8"));
const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => /^(SDLC_PREFLIGHT_|UPSTREAM_DIR$|TARGET_SHA$|LAST_MERGED_SHA$|SDLC_MANIFEST$)/.test(name)));
fs.appendFileSync(path.join(here, "check-drift.log.jsonl"), `${JSON.stringify({ args: process.argv.slice(2), cwd: process.cwd(), upstreamDir: process.env.UPSTREAM_DIR ?? null, env })}\n`);
if (config.stdout !== undefined) process.stdout.write(typeof config.stdout === "string" ? config.stdout : `${JSON.stringify(config.stdout)}\n`);
if (config.stderr) process.stderr.write(config.stderr);
process.exit(config.code ?? 0);
