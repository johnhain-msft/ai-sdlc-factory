// Where the fleet manifest lives at run time (design section D): `SDLC_MANIFEST` (a workspace-relative path, default sdlc.yaml) is read through one
// helper by every runtime reader, and the renderer hands it to the steps that read the manifest when the request names another file.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import YAML from "yaml";
import { run as runSnapshot } from "../src/snapshot-watch-sources.mjs";
import { locateManifest, readManifest, ManifestError } from "../src/adaptation/manifest.mjs";
import { renderFleet } from "../src/reconcile.mjs";
import { findEdgeBySlug, loadManifestEdges } from "../src/routing/edges.mjs";
import { DEFAULT_MANIFEST_FILE, MANIFEST_ENV, manifestPathIn, manifestRelativePath, workspaceManifestPath } from "../src/lib/manifest-location.mjs";
import { parseBootstrapArgs, parseOnboardArgs } from "../bin/lib/cli-flags.mjs";
import { createWorkspace, referenceRequest } from "./helpers/mini-fleet.mjs";

const ENGINE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CUSTOM = "config/fleet.yaml";
const frontmatterOf = (text) => YAML.parse(/^---\n([\s\S]*?)\n---\n/.exec(text)[1]);
const withEnv = (name, value, body) => {
  const before = process.env[name];
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
  try {
    return body();
  } finally {
    if (before === undefined) delete process.env[name];
    else process.env[name] = before;
  }
};

// ---- the helper ----------------------------------------------------------------------------------------------------------------------------

test("the default is sdlc.yaml, for an unset and for an empty variable", () => {
  assert.equal(MANIFEST_ENV, "SDLC_MANIFEST");
  assert.equal(DEFAULT_MANIFEST_FILE, "sdlc.yaml");
  assert.equal(manifestRelativePath({}), "sdlc.yaml");
  assert.equal(manifestRelativePath({ SDLC_MANIFEST: "" }), "sdlc.yaml");
  withEnv("SDLC_MANIFEST", undefined, () => assert.equal(manifestRelativePath(), "sdlc.yaml"));
});

test("the variable is honoured, .yaml and .yml, and a dot or empty segment is normalized away", () => {
  const longest = `${"a".repeat(195)}.yaml`;
  const cases = [
    [CUSTOM, CUSTOM],
    [longest, longest],
    ["fleet.yml", "fleet.yml"],
    ["a/b/c-d_e.f@g.yaml", "a/b/c-d_e.f@g.yaml"],
    [".github/fleet.yaml", ".github/fleet.yaml"],
    ["./sdlc.yaml", "sdlc.yaml"],
    ["config/./fleet.yaml", CUSTOM],
    ["config//fleet.yaml", CUSTOM],
  ];
  for (const [given, expected] of cases) assert.equal(manifestRelativePath({ SDLC_MANIFEST: given }), expected, given);
  withEnv("SDLC_MANIFEST", CUSTOM, () => assert.equal(manifestRelativePath(), CUSTOM));
});

test("absolute paths, drive letters, .., other characters, other extensions and option lookalikes are refused", () => {
  const refused = [
    "/etc/fleet.yaml",
    "\\\\server\\share\\fleet.yaml",
    "C:\\fleet.yaml",
    "C:/fleet.yaml",
    "../fleet.yaml",
    "config/../fleet.yaml",
    "..",
    "config\\fleet.yaml",
    "fleet.json",
    "fleet",
    "config/",
    "fleet.YAML",
    "my fleet.yaml",
    " fleet.yaml",
    "fleet.yaml ",
    "fleet;touch-x.yaml",
    "fleet$(id).yaml",
    "fleet`id`.yaml",
    'fleet".yaml',
    "fleet'.yaml",
    "fleet.yaml\n",
    "-fleet.yaml",
    `${"a".repeat(196)}.yaml`,
    `${"a".repeat(300)}.yaml`,
  ];
  for (const given of refused) {
    assert.throws(() => manifestRelativePath({ SDLC_MANIFEST: given }), (error) => error.name === "ManifestLocationError" && error.message.includes("SDLC_MANIFEST"), JSON.stringify(given));
  }
});

test("manifestPathIn joins the resolved name to a root", () => {
  assert.equal(manifestPathIn("/work", {}), path.join("/work", "sdlc.yaml"));
  assert.equal(manifestPathIn("/work", { SDLC_MANIFEST: CUSTOM }), path.join("/work", "config", "fleet.yaml"));
});

test("workspaceManifestPath: the request's manifestPath, relative or absolute, becomes the workspace-relative POSIX path", (t) => {
  const work = createWorkspace(t);
  assert.equal(workspaceManifestPath(work.dir, "sdlc.yaml"), "sdlc.yaml");
  assert.equal(workspaceManifestPath(work.dir, work.path("sdlc.yaml")), "sdlc.yaml");
  assert.equal(workspaceManifestPath(work.dir, CUSTOM), CUSTOM);
  assert.equal(workspaceManifestPath(work.dir, work.path("config", "fleet.yaml")), CUSTOM);
  assert.throws(() => workspaceManifestPath(work.dir, path.join(path.dirname(work.dir), "elsewhere.yaml")), /outside the repository/);
  assert.throws(() => workspaceManifestPath(work.dir, "../elsewhere.yaml"), /outside the repository/);
  assert.throws(() => workspaceManifestPath(work.dir, "config/my fleet.yaml"), /SDLC_MANIFEST|manifest path/);
});

// ---- the readers ---------------------------------------------------------------------------------------------------------------------------

test("loadManifestEdges and findEdgeBySlug read the file that SDLC_MANIFEST names, and their messages name it", (t) => {
  const work = createWorkspace(t, { manifestPath: CUSTOM });
  const env = { SDLC_MANIFEST: CUSTOM };
  const io = { fs, env };
  const loaded = loadManifestEdges(work.dir, io);
  assert.equal(loaded.found, true);
  assert.deepEqual(loaded.edges.map((edge) => edge.edgeId), ["docs-to-hub", "lab-to-hub"]);
  assert.equal(findEdgeBySlug(work.dir, "DOCS_SITE", io).edge.edgeId, "docs-to-hub");
  // without the variable the reader looks for sdlc.yaml, which this workspace does not have
  assert.equal(loadManifestEdges(work.dir, { fs, env: {} }).found, false);
  assert.throws(() => findEdgeBySlug(work.dir, "DOCS_SITE", { fs, env: {} }), (error) => error.message.includes("sdlc.yaml") && !error.message.includes("fleet.yaml"));
  const missing = createWorkspace(t);
  assert.throws(() => findEdgeBySlug(missing.dir, "DOCS_SITE", io), (error) => error.message.includes("fleet.yaml"));
  assert.throws(() => loadManifestEdges(work.dir, { fs, env: { SDLC_MANIFEST: "../x.yaml" } }), (error) => error.name === "RoutingDataError" && error.message.includes("SDLC_MANIFEST"));
});

test("locateManifest and readManifest find the file that SDLC_MANIFEST names, still skip a candidate inside an avoided directory, and name it when it is missing", async (t) => {
  const work = createWorkspace(t, { manifestPath: CUSTOM });
  const env = { SDLC_MANIFEST: CUSTOM };
  assert.equal(locateManifest({ cwd: work.dir, env }), path.join(work.dir, "config", "fleet.yaml"));
  assert.equal(locateManifest({ cwd: work.dir, env: {} }), null);
  assert.equal(locateManifest({ cwd: path.join(work.dir, "elsewhere"), env: { ...env, GITHUB_WORKSPACE: work.dir } }), path.join(work.dir, "config", "fleet.yaml"));
  assert.equal(locateManifest({ cwd: work.dir, env, avoid: [path.join(work.dir, "config")] }), null);
  const read = await readManifest({ cwd: work.dir, env });
  assert.equal(read.file, path.join(work.dir, "config", "fleet.yaml"));
  assert.equal(read.document.projects.length, 3);
  await assert.rejects(readManifest({ cwd: work.dir, env: {} }), (error) => error instanceof ManifestError && error.message.includes("sdlc.yaml"));
  await assert.rejects(readManifest({ cwd: work.dir, env: { SDLC_MANIFEST: "other/fleet.yaml" } }), (error) => error instanceof ManifestError && error.message.includes("other/fleet.yaml"));
  await assert.rejects(readManifest({ cwd: work.dir, env: { SDLC_MANIFEST: "/abs.yaml" } }), (error) => error instanceof ManifestError && error.message.includes("SDLC_MANIFEST"));
});

test("the snapshot script reads the manifest that SDLC_MANIFEST names when --manifest is not given", async (t) => {
  const work = createWorkspace(t, {
    manifestPath: CUSTOM,
    mutate: (manifest) => {
      manifest.projects[0].driftAudit.knowledgeSources.watchUrls = [];
    },
  });
  const out = work.path("out");
  const call = (env) => {
    const captured = { stdout: "", stderr: "" };
    const io = { cwd: work.dir, env: { GITHUB_WORKSPACE: work.dir, ...env }, stdout: (text) => (captured.stdout += text), stderr: (text) => (captured.stderr += text) };
    return runSnapshot(["--out", out, "--project", "docs-site"], io).then((code) => ({ code, ...captured }));
  };
  const found = await call({ SDLC_MANIFEST: CUSTOM });
  assert.equal(found.code, 0, found.stderr);
  assert.equal(fs.existsSync(path.join(out, "sources", "manifest.json")), true);
  const missing = await call({});
  assert.notEqual(missing.code, 0);
  assert.match(missing.stderr, /sdlc\.yaml/);
  const explicit = await runSnapshot(["--out", out, "--project", "docs-site", "--manifest", CUSTOM], { cwd: work.dir, env: { GITHUB_WORKSPACE: work.dir }, stdout() {}, stderr() {} });
  assert.equal(explicit, 0, "an explicit --manifest still wins");
});

test("the bootstrap and onboard CLIs default --manifest to SDLC_MANIFEST", () => {
  withEnv("SDLC_MANIFEST", undefined, () => {
    assert.equal(parseBootstrapArgs([]).manifest, "sdlc.yaml");
    assert.equal(parseOnboardArgs(["example-org/example-app"]).manifest, "sdlc.yaml");
  });
  withEnv("SDLC_MANIFEST", CUSTOM, () => {
    assert.equal(parseBootstrapArgs([]).manifest, CUSTOM);
    assert.equal(parseOnboardArgs(["example-org/example-app"]).manifest, CUSTOM);
    assert.equal(parseBootstrapArgs(["--manifest", "other.yaml"]).manifest, "other.yaml", "the flag wins");
  });
});

test("the central-repo debug command resolves its default manifest through the helper", (t) => {
  const work = createWorkspace(t, { manifestPath: CUSTOM });
  const git = (...args) => spawnSync("git", args, { cwd: work.dir, encoding: "utf8", windowsHide: true });
  assert.equal(git("init", "-q").status, 0);
  assert.equal(git("remote", "add", "origin", "https://github.com/example-org/example-app.git").status, 0);
  const command = path.join(ENGINE_ROOT, "bin", "lib", "central-repo.mjs");
  const run = (env) => spawnSync(process.execPath, [command], { cwd: work.dir, encoding: "utf8", windowsHide: true, env: { ...process.env, SDLC_MANIFEST: "", ...env } });
  const ok = run({ SDLC_MANIFEST: CUSTOM });
  assert.equal(ok.status, 0, ok.stderr);
  assert.equal(ok.stdout.trim(), "example-org/example-app");
  const bad = run({ SDLC_MANIFEST: "../outside.yaml" });
  assert.notEqual(bad.status, 0);
  assert.match(bad.stderr, /SDLC_MANIFEST/);
});

// ---- the renderer --------------------------------------------------------------------------------------------------------------------------

const stepsOf = (frontmatter, jobName) => frontmatter.jobs[jobName].steps;
const named = (steps, name) => steps.find((step) => step.name === name);

function render(t, { manifestPath = "sdlc.yaml", requestPath, mutate } = {}) {
  const work = createWorkspace(t, { manifestPath, mutate });
  const result = renderFleet(referenceRequest({ manifestPath: requestPath ?? manifestPath }), { cwd: work.dir });
  assert.equal(result.ok, true, JSON.stringify(result.result));
  return { work, files: result.files };
}

test("the default manifest path adds nothing to any rendered file", (t) => {
  const { files } = render(t);
  for (const [file, text] of files) {
    assert.equal(text.includes("SDLC_MANIFEST"), false, `${file} must not mention SDLC_MANIFEST`);
    // the onboarding prompt documents the --manifest flag of the onboarding command; no other file passes it
    if (!file.endsWith("sdlc-onboard.md")) assert.equal(text.includes("--manifest"), false, `${file} must not pass --manifest`);
  }
  // the same manifest named by an absolute path inside the workspace is the default as well
  const work = createWorkspace(t);
  const absolute = renderFleet(referenceRequest({ manifestPath: work.path("sdlc.yaml") }), { cwd: work.dir });
  assert.equal(absolute.ok, true);
  for (const [file, text] of files) assert.equal(absolute.files.get(file), text, `${file} is identical for an absolute path`);
});

test("another manifest path reaches every step that reads the manifest, and nothing else", (t) => {
  const { files } = render(t, {
    manifestPath: CUSTOM,
    mutate: (manifest) => {
      manifest.projects[0].driftAudit.knowledgeSources.watchUrls = manifest.projects[0].driftAudit.knowledgeSources.watchUrls.slice(0, 1);
    },
  });
  const router = YAML.parse(files.get(".github/workflows/cascade-router.yml"));
  const route = named(router.jobs.route.steps, "Route the upstream");
  assert.equal(route.env.SDLC_MANIFEST, CUSTOM);

  for (const id of ["cascade-mechanical-docs-to-hub", "cascade-ai-lab-to-hub"]) {
    const fm = frontmatterOf(files.get(`.github/workflows/${id}.md`));
    assert.equal(named(stepsOf(fm, "finalize_poll_state"), "Update the poll state").env.SDLC_MANIFEST, CUSTOM, `${id} finalize_poll_state`);
    assert.equal(named(stepsOf(fm, "escalate_failure"), "Record the failure").env.SDLC_MANIFEST, CUSTOM, `${id} escalate_failure`);
  }
  const ai = frontmatterOf(files.get(".github/workflows/cascade-ai-lab-to-hub.md"));
  const gate = ai["post-steps"].find((step) => String(step.run).includes("verify-immutable-gates.mjs"));
  assert.equal(gate.env.SDLC_MANIFEST, CUSTOM);
  assert.equal(gate.name.includes("SDLC_MANIFEST"), false, "the step name stays the command");

  const drift = frontmatterOf(files.get(".github/workflows/drift-docs-site.md"));
  const snapshot = named(drift["pre-agent-steps"], "Snapshot watched sources and package manifests");
  assert.ok(snapshot.run.endsWith(` --manifest "$GITHUB_WORKSPACE/${CUSTOM}"`), snapshot.run);

  // the files that never read the manifest are as they are without the variable
  const mechanical = frontmatterOf(files.get(".github/workflows/cascade-mechanical-docs-to-hub.md"));
  assert.equal(JSON.stringify(mechanical["pre-agent-steps"]).includes("SDLC_MANIFEST"), false);
  assert.equal(JSON.stringify(mechanical["post-steps"]).includes("SDLC_MANIFEST"), false);
  assert.equal(files.get(".github/workflows/sdlc-onboard.md").includes("SDLC_MANIFEST"), false);
});

test("an absolute manifestPath inside the workspace renders like the relative one", (t) => {
  const relative = render(t, { manifestPath: CUSTOM });
  const work = createWorkspace(t, { manifestPath: CUSTOM });
  const absolute = renderFleet(referenceRequest({ manifestPath: work.path("config", "fleet.yaml") }), { cwd: work.dir });
  assert.equal(absolute.ok, true, JSON.stringify(absolute.result));
  for (const [file, text] of relative.files) assert.equal(absolute.files.get(file), text, file);
});

test("a manifest path that a rendered workflow cannot name is refused with a rule id", (t) => {
  const outside = createWorkspace(t);
  const elsewhere = createWorkspace(t, { manifestPath: "fleet.yaml" });
  const result = renderFleet(referenceRequest({ manifestPath: elsewhere.path("fleet.yaml") }), { cwd: outside.dir });
  assert.equal(result.ok, false);
  assert.match(JSON.stringify(result.result), /manifest-path-invalid/);
  const spaced = createWorkspace(t, { manifestPath: "config/my fleet.yaml" });
  const bad = renderFleet(referenceRequest({ manifestPath: "config/my fleet.yaml" }), { cwd: spaced.dir });
  assert.equal(bad.ok, false);
  assert.match(JSON.stringify(bad.result), /manifest-path-invalid/);
});

// ---- the guard -----------------------------------------------------------------------------------------------------------------------------

test("only manifest-location.mjs spells the default manifest name as a string literal in src/ and bin/", () => {
  const offenders = [];
  const visit = (directory) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const full = path.join(directory, entry.name);
      if (entry.isDirectory()) visit(full);
      else if (entry.name.endsWith(".mjs") && fs.readFileSync(full, "utf8").includes('"sdlc.yaml"')) offenders.push(path.relative(ENGINE_ROOT, full).split(path.sep).join("/"));
    }
  };
  visit(path.join(ENGINE_ROOT, "src"));
  visit(path.join(ENGINE_ROOT, "bin"));
  assert.deepEqual(offenders, ["src/lib/manifest-location.mjs"]);
});
