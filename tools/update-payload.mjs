#!/usr/bin/env node
// Regenerates payload/workflows/sdlc-onboard.md: the onboarding workflow that the package ships without a GitHub App, as the renderer produces it
// (renderOnboardPayload). Never edit that file by hand: the next `sdlc-reconcile` of an orchestrator overwrites its copy with the real App slug, and
// tests/payload.test.mjs fails when the committed file is not what the renderer says.
//
//   node tools/update-payload.mjs           write the file
//   node tools/update-payload.mjs --check   write nothing; exit 1 when the committed file differs from the renderer's output

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { renderOnboardPayload } from "../src/reconcile.mjs";

export const PAYLOAD_FILE = "payload/workflows/sdlc-onboard.md";
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const USAGE = "usage: node tools/update-payload.mjs [--check]";

/**
 * @param {string[]} argv the arguments after the script name
 * @param {{ root?: string, render?: () => string, stdout?: { write(text: string): unknown }, stderr?: { write(text: string): unknown } }} [options]
 * @returns {number} the exit code: 0 written or in sync, 1 out of sync under --check, 2 usage
 */
export function main(argv, { root = ROOT, render = renderOnboardPayload, stdout = process.stdout, stderr = process.stderr } = {}) {
  if (argv.length > 1 || argv.some((argument) => argument !== "--check")) {
    stderr.write(`${USAGE}\n`);
    return 2;
  }
  const target = path.join(root, ...PAYLOAD_FILE.split("/"));
  const text = render();
  const current = fs.existsSync(target) ? fs.readFileSync(target, "utf8") : null;
  if (argv[0] === "--check") {
    if (current === text) {
      stdout.write(`${PAYLOAD_FILE} is what the renderer produces\n`);
      return 0;
    }
    stderr.write(`${PAYLOAD_FILE} is not what the renderer produces: run node tools/update-payload.mjs and commit the result\n`);
    return 1;
  }
  if (current === text) {
    stdout.write(`${PAYLOAD_FILE} is up to date\n`);
    return 0;
  }
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, text);
  stdout.write(`wrote ${PAYLOAD_FILE}\n`);
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  process.exitCode = main(process.argv.slice(2));
}
