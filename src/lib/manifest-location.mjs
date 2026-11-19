// The one place that knows where the fleet manifest lives at run time.
//
// The manifest is `sdlc.yaml` at the root of the orchestrator workspace unless `SDLC_MANIFEST` names another workspace-relative file. Every
// runtime reader (the router, the poll-state scripts, the gate verifier, the snapshot script, the dedupe script, the bootstrap and onboarding
// commands) resolves it through this module, and the renderer hands the variable to the steps that read the manifest when a fleet keeps it elsewhere.
// The path is relative on purpose: the policy source has to stay inside the orchestrator workspace, never in a checkout that an agent could write.
//
// This module reads nothing and imports only node:path, so the scripts that run in a job without `npm ci` can use it.

import path from "node:path";

export const MANIFEST_ENV = "SDLC_MANIFEST";
export const DEFAULT_MANIFEST_FILE = "sdlc.yaml";

const MAX_LENGTH = 200;
const ALLOWED_CHARACTERS = /^[A-Za-z0-9._@/-]+$/;

/** The manifest location is unusable: a message that names the variable or the path and what is wrong with it. */
export class ManifestLocationError extends Error {
  constructor(message) {
    super(message);
    this.name = "ManifestLocationError";
  }
}

/**
 * Why a string cannot be the workspace-relative path of the manifest, or null when it can. The path is interpolated into shell text and into
 * file system calls, so it is restricted to `[A-Za-z0-9._@/-]`, to a `.yaml` or `.yml` name, to no `..` segment and to no leading `/` or `-`.
 */
export function manifestPathProblem(value) {
  if (typeof value !== "string" || value === "") return "is empty";
  if (value.length > MAX_LENGTH) return `is longer than ${MAX_LENGTH} characters`;
  if (/^[A-Za-z]:/.test(value)) return "must not start with a drive letter";
  if (value.includes("\\")) return "must use '/' as the separator";
  if (!ALLOWED_CHARACTERS.test(value)) return "may use only the characters A-Z a-z 0-9 . _ @ / -";
  if (value.startsWith("/")) return "must be relative to the repository root, not absolute";
  if (value.startsWith("-")) return "must not start with '-'";
  if (value.split("/").includes("..")) return "must not contain a '..' segment";
  if (!/\.ya?ml$/.test(value)) return "must name a .yaml or .yml file";
  return null;
}

/**
 * The workspace-relative POSIX path of the manifest: `$SDLC_MANIFEST`, else `sdlc.yaml`. An empty variable counts as unset (a workflow expands an unset
 * variable to the empty string). Dot and empty segments are normalized away.
 * @throws {ManifestLocationError} when the variable holds a value that manifestPathProblem refuses
 */
export function manifestRelativePath(env = process.env) {
  const raw = env?.[MANIFEST_ENV];
  if (raw === undefined || raw === null || raw === "") return DEFAULT_MANIFEST_FILE;
  const value = String(raw);
  const problem = manifestPathProblem(value);
  if (problem !== null) throw new ManifestLocationError(`${MANIFEST_ENV}=${JSON.stringify(value.slice(0, 80))} ${problem}`);
  return path.posix.normalize(value);
}

/** The absolute path of the manifest under `root`. @throws {ManifestLocationError} */
export const manifestPathIn = (root, env = process.env) => path.join(root, ...manifestRelativePath(env).split("/"));

/** The manifest's name for a message: the resolved path, or the default one when the variable is unusable (a message must not throw). */
export function manifestNameForMessage(env = process.env) {
  try {
    return manifestRelativePath(env);
  } catch {
    return DEFAULT_MANIFEST_FILE;
  }
}

/**
 * The workspace-relative POSIX path of the manifest that a reconcile request names (`request.manifestPath` is absolute when the bootstrap sends it and
 * may be relative to `cwd` otherwise), which is what a rendered workflow has to pass on as SDLC_MANIFEST when it is not `sdlc.yaml`.
 * @throws {ManifestLocationError} when the file is outside `cwd` or its path could not be passed to a shell step
 */
export function workspaceManifestPath(cwd, manifestPath) {
  const root = path.resolve(cwd);
  const relative = path.relative(root, path.resolve(root, manifestPath)).split(path.sep).join("/");
  if (relative === "" || relative === ".." || relative.startsWith("../") || path.isAbsolute(relative)) {
    throw new ManifestLocationError(`the manifest ${JSON.stringify(String(manifestPath))} is outside the repository at ${root}, so a rendered workflow cannot name it`);
  }
  const problem = manifestPathProblem(relative);
  if (problem !== null) throw new ManifestLocationError(`the manifest path ${JSON.stringify(relative)} ${problem}, so a rendered workflow cannot pass it on as ${MANIFEST_ENV}`);
  return path.posix.normalize(relative);
}
