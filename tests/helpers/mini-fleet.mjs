// A small synthetic fleet for the engine's focused tests: three projects and two edges whose names are example-org/..., so that a test
// can render, mutate and re-render it without a live manifest. Nothing here belongs to a real adopter.
//
//   const work = createWorkspace(t);                      // a temp workspace with the manifest at sdlc.yaml
//   const work = createWorkspace(t, { manifestPath: "config/fleet.yaml", mutate: (m) => { ... } });
//   const result = renderFleet(referenceRequest(), { cwd: work.dir });

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import YAML from "yaml";

export const REFERENCE_REQUEST = Object.freeze({
  manifestPath: "sdlc.yaml",
  appSlug: "example-orchestrator",
  appClientIdVar: "APP_CLIENT_ID",
  appPrivateKeySecret: "APP_PRIVATE_KEY",
  pollStateVarPrefix: "SDLC_SYNC_STATE_",
  engineAuthMode: "copilot-pat",
  ghAwVersionPin: ">=v1.0.1",
  securityBaseline: {
    minGhAwVersion: "1.0.1",
    grantedAppPermissions: { contents: "write", pull_requests: "write", issues: "write", actions: "write", variables: "write", metadata: "read" },
    requireStrictMode: true,
    requireThreatDetection: true,
    forbidAutoMerge: true,
  },
  dryRun: false,
});

/** The nine-key reconcile request, with the given fields replaced. */
export const referenceRequest = (overrides = {}) => ({ ...structuredClone(REFERENCE_REQUEST), ...overrides });

const SHA = "0123456789abcdef0123456789abcdef01234567";

function project(projectKey, repo, driftAudit) {
  return {
    projectKey,
    repo,
    defaultBranch: "main",
    driftAudit: {
      enabled: false,
      schedule: "15 4 * * 2",
      upkeepStrategy: "content-and-docs-sync",
      instructions: "",
      instructionsFile: null,
      knowledgeSources: { watchUrls: [], packageManifests: [], mcpServers: {} },
      buildCommands: [],
      verifyCommands: [],
      draft: false,
      reviewers: [],
      ...driftAudit,
    },
  };
}

function edge(fields) {
  return {
    upstreamDefaultBranch: "main",
    initialBaselineSha: SHA,
    schedule: "0 */6 * * *",
    onCommitOnlyAdvance: "noop",
    provenanceFile: "provenance.json",
    provenanceJsonPointer: "/commit",
    reviewers: ["example-reviewer"],
    importCommands: [],
    preflightCommands: [],
    acceptCommands: [],
    buildCommands: [],
    verifyCommands: [],
    adaptationInstructions: "",
    protectedFilesExclude: [],
    autoMerge: false,
    immutableGates: { zeroDiffPaths: [] },
    ...fields,
  };
}

/** The manifest object of the mini fleet. */
export function miniManifest() {
  const drifting = {
    enabled: true,
    instructions: "Keep the documentation of this repository current.",
    knowledgeSources: { watchUrls: [{ url: "https://example.org/changelog", label: "Example changelog", kind: "changelog" }], packageManifests: [], mcpServers: {} },
    verifyCommands: ["npm ci", "npm test"],
    reviewers: ["example-reviewer"],
  };
  return {
    projects: [
      project("docs-site", "example-org/docs-site", drifting),
      project("lab-content", "example-org/lab-content", { ...drifting, upkeepStrategy: "code-quality-and-improvement-scan" }),
      project("hub", "example-org/hub", {}),
    ],
    dependencyEdges: [
      edge({
        edgeId: "docs-to-hub",
        upstreamRepo: "example-org/docs-site",
        upstreamKey: "docs-site",
        upstreamSlug: "DOCS_SITE",
        downstreamRepo: "example-org/hub",
        mode: "mechanical",
        stateVariable: "SDLC_SYNC_STATE_DOCS_SITE",
        branchName: "sdlc/cascade-docs-to-hub",
        closeOlderKey: "sdlc-cascade-docs-to-hub",
        importCommands: ["node scripts/import.mjs <checkout>"],
        buildCommands: ["npm run build"],
        verifyCommands: ["npm test"],
        allowedFiles: ["docs/imported/**"],
      }),
      edge({
        edgeId: "lab-to-hub",
        upstreamRepo: "example-org/lab-content",
        upstreamKey: "lab-content",
        upstreamSlug: "LAB_CONTENT",
        downstreamRepo: "example-org/hub",
        mode: "ai-adaptation",
        stateVariable: "SDLC_SYNC_STATE_LAB_CONTENT",
        branchName: "sdlc/cascade-lab-to-hub",
        closeOlderKey: "sdlc-cascade-lab-to-hub",
        preflightCommands: ['git -C <checkout> diff --quiet "$LAST_MERGED_SHA" "$TARGET_SHA"'],
        buildCommands: ["npm run build"],
        verifyCommands: ["npm test"],
        adaptationInstructions: "Adapt the hub pages to the lab content.",
        allowedFiles: ["site/**"],
        immutableGates: { zeroDiffPaths: ["kernel"] },
      }),
    ],
  };
}

/**
 * A temporary workspace holding the manifest at `manifestPath` (default sdlc.yaml). `mutate(manifest)` may edit the object before it is written;
 * `files` maps a workspace-relative path to its text. The directory is removed when the test ends.
 */
export function createWorkspace(t, { manifestPath = "sdlc.yaml", mutate, manifest = miniManifest(), files = {}, text } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sdlc-mini-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const write = (relative, content) => {
    const target = path.join(dir, ...relative.split("/"));
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, content);
    return target;
  };
  if (mutate) mutate(manifest);
  write(manifestPath, text ?? YAML.stringify(manifest, { lineWidth: 0 }));
  for (const [relative, content] of Object.entries(files)) write(relative, content);
  return { dir, write, path: (...parts) => path.join(dir, ...parts), manifest };
}
