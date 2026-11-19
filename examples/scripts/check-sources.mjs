#!/usr/bin/env node
// A helper of the orchestrator that has its own flags and its own exit codes (design E5): it compares the views of the downstream with the upstream sources that
// they were written from. An edge's preflight runs it, and its accept commands run it again with --accept.
//
//   node scripts/check-sources.mjs --downstream <dir> --upstream <dir> --commit <sha> [--accept]
//
// What it compares is data of the orchestrator's manifest, not of this script: adaptation.helpers.sourceCheck.manifest names a JSON file of the downstream,
//   { "_provenance": { "commit": "<sha>" }, "views": { "<view>": { "source": "<path in the upstream>", "sha256": "<hash of that file when the view was written>" } } }
// and the manifest is read from the orchestrator's workspace, never from the downstream checkout that is being inspected (the `avoid` option).
//
//   exit 0  in sync: every source has the hash that its view recorded
//   exit 1  drift: one or more sources changed or are gone; stdout is { "status": "drift", "changed": [...] }
//   exit 2  fatal: a flag, the manifest or a file is wrong; nothing was decided and nothing was written
//
// --accept records the hashes and the commit instead of comparing them, and exits 0.

import crypto from "node:crypto";
import path from "node:path";
import { ManifestError, UsageError, helperSection, parseFlags, readManifest, relativePath, resolveIo, runAsMain, stableJson, writeFilesAtomically } from "ai-sdlc-factory/script-kit";

const OPTIONS = { downstream: { type: "string" }, upstream: { type: "string" }, commit: { type: "string" }, accept: { type: "boolean" } };
const SHA = /^[0-9a-f]{40}$/;

const hashOf = (io, file) => (io.fs.existsSync(file) ? crypto.createHash("sha256").update(io.fs.readFileSync(file)).digest("hex") : null);

export async function run(argv, ioInput = {}) {
  const io = resolveIo(ioInput);
  try {
    const flags = parseFlags(argv, OPTIONS);
    for (const name of ["downstream", "upstream", "commit"]) if (!flags[name]) throw new UsageError(`--${name} is required`);
    if (!SHA.test(flags.commit)) throw new UsageError("--commit must be 40 lowercase hexadecimal characters");
    const downstream = path.resolve(io.cwd, flags.downstream);
    const upstream = path.resolve(io.cwd, flags.upstream);

    const { document } = await readManifest({ cwd: io.cwd, env: io.env, avoid: [downstream] });
    const section = helperSection(document, "sourceCheck");
    if (section === null) throw new ManifestError("no edge declares adaptation.helpers.sourceCheck");
    const sources = path.join(downstream, ...relativePath(section.manifest, "adaptation.helpers.sourceCheck.manifest").split("/"));
    const recorded = JSON.parse(io.fs.readFileSync(sources, "utf8"));

    const views = Object.entries(recorded.views ?? {}).map(([name, view]) => ({ name, view, hash: hashOf(io, path.join(upstream, ...relativePath(view.source, `the source of ${name}`).split("/"))) }));
    if (flags.accept) {
      const next = { ...recorded, _provenance: { ...recorded._provenance, commit: flags.commit }, views: Object.fromEntries(views.map(({ name, view, hash }) => [name, { ...view, sha256: hash }])) };
      writeFilesAtomically([{ path: sources, data: stableJson(next) }], { fs: io.fs });
      io.stdout(`${JSON.stringify({ status: "accepted", commit: flags.commit })}\n`);
      return 0;
    }
    const changed = views.filter(({ view, hash }) => hash !== view.sha256).map(({ name }) => name);
    io.stdout(`${JSON.stringify({ status: changed.length === 0 ? "in-sync" : "drift", changed })}\n`);
    return changed.length === 0 ? 0 : 1;
  } catch (error) {
    if (!(error instanceof UsageError || error instanceof ManifestError || error?.code === "ENOENT" || error instanceof SyntaxError)) throw error;
    io.stderr(`check-sources: ${error.message}\n`);
    return 2;
  }
}

await runAsMain(import.meta.url, run);
