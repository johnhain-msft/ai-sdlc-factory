#!/usr/bin/env node
// The validator that the verification gate of a drift workflow runs after the agent: it checks that the report that the agent wrote has the sections
// that its registration instructions require.
//
//   node scripts/validate-example.mjs                  checks reports/audit-report.md in the working directory (the target checkout)
//   node scripts/validate-example.mjs --self-improve   checks reports/improvement-report.md
//
// The workflow stages this file and ai-sdlc-factory/drift-lib before the agent starts, in a read-only copy, compares them with the workspace copies, and then runs the
// STAGED copy, so that nothing that the agent writes in the workspace can change what runs. That is why this file imports nothing but the drift-lib and node: modules:
// they are all that the stage holds.
//
//   exit 0  the report is valid
//   exit 1  it is not: each problem is printed on standard error
//   exit 2  a flag is wrong

import path from "node:path";
import { UsageError, parseFlags, resolveIo, runAsMain } from "ai-sdlc-factory/drift-lib";

const OPTIONS = { "self-improve": { type: "boolean" } };
const SECTIONS = {
  audit: { file: "reports/audit-report.md", required: ["## Summary", "## Verification", "## Proposed additions", "## Run details"] },
  improvement: { file: "reports/improvement-report.md", required: ["## Summary", "## Findings", "## Run details"] },
};

export async function run(argv, ioInput = {}) {
  const io = resolveIo(ioInput);
  let flags;
  try {
    flags = parseFlags(argv, OPTIONS);
  } catch (error) {
    if (!(error instanceof UsageError)) throw error;
    io.stderr(`validate-example: ${error.message}\n`);
    return 2;
  }
  const { file, required } = flags["self-improve"] ? SECTIONS.improvement : SECTIONS.audit;
  const target = path.join(io.cwd, ...file.split("/"));
  if (!io.fs.existsSync(target)) {
    io.stderr(`validate-example: ${file} does not exist\n`);
    return 1;
  }
  const headings = io.fs.readFileSync(target, "utf8").split(/\r?\n/).filter((line) => /^## /.test(line)).map((line) => line.trimEnd());
  const problems = [];
  for (const section of required) {
    const count = headings.filter((heading) => heading === section).length;
    if (count === 0) problems.push(`${file} has no '${section}' section`);
    if (count > 1) problems.push(`${file} has the '${section}' section ${count} times`);
  }
  const order = headings.filter((heading) => required.includes(heading));
  if (problems.length === 0 && order.join("\n") !== required.join("\n")) problems.push(`${file} has its sections in the wrong order: expected ${required.join(", ")}`);
  for (const problem of problems) io.stderr(`validate-example: ${problem}\n`);
  if (problems.length === 0) io.stdout(`validate-example: ${file} is valid\n`);
  return problems.length === 0 ? 0 : 1;
}

await runAsMain(import.meta.url, run);
