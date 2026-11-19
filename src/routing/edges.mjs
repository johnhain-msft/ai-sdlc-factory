// The dependency edges that the S3 scripts read (SPEC-03 AC5, AC10, AC46): the edge of one router job from EDGE_JSON, and the edges of
// sdlc.yaml for the scripts that start from a slug or from a signal. Every repository, branch, key and variable name is data of an edge;
// nothing here names one.

import YAML from "yaml";
import { resolveFactory } from "../lib/factory-block.mjs";
import { manifestPathIn, ManifestLocationError } from "../lib/manifest-location.mjs";
import { assertShape, RoutingDataError, validateShape } from "./schema.mjs";
import { DIALECT_SETTINGS } from "./sync-state.mjs";

/** The manifest file of `workspace`: $SDLC_MANIFEST (a workspace-relative path) from the job's environment, else sdlc.yaml. @throws {RoutingDataError} */
function manifestFile(workspace, io) {
  try {
    return manifestPathIn(workspace, io?.env);
  } catch (error) {
    if (error instanceof ManifestLocationError) throw new RoutingDataError(error.message);
    throw error;
  }
}

/**
 * The manifest's `state.dialect`: which spelling of the fourth field of the sync state a write uses (preserve, the default: the one that was read). A value that is
 * not one of the three is refused, because a typo that fell back to preserve would never convert anything.
 * @throws {RoutingDataError}
 */
export function stateDialectSetting(document, file) {
  const setting = document?.state?.dialect;
  if (setting === undefined) return "preserve";
  if (!DIALECT_SETTINGS.includes(setting)) throw new RoutingDataError(`${file}: state.dialect ${JSON.stringify(setting)} must be one of ${DIALECT_SETTINGS.join(", ")}`);
  return setting;
}

export const splitSlug = (slug) => {
  const text = String(slug);
  const slash = text.indexOf("/");
  return { owner: text.slice(0, slash), repo: text.slice(slash + 1) };
};

/** The identifier of the workflow that an edge dispatches, as SPEC-01 names it. */
export const cascadeWorkflowId = (edge) => (edge.mode === "mechanical" ? `cascade-mechanical-${edge.edgeId}` : `cascade-ai-${edge.edgeId}`);

/** The workflow file that is dispatched (the compiled lock file: contract C7 names it). */
export const cascadeWorkflowFile = (edge) => `${cascadeWorkflowId(edge)}.lock.yml`;

const isObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);

/**
 * The edge of a router job (EDGE_JSON). @throws {RoutingDataError}
 * @returns {object}
 */
export function parseEdgeJson(text, expectedKey) {
  let edge;
  try {
    edge = JSON.parse(String(text ?? ""));
  } catch (error) {
    throw new RoutingDataError(`EDGE_JSON is not JSON: ${error.message}`);
  }
  assertShape("RouterEdge", edge, "EDGE_JSON");
  if (expectedKey !== undefined && edge.upstreamKey !== expectedKey) {
    throw new RoutingDataError(`EDGE_JSON describes the upstream '${edge.upstreamKey}', but this job routes '${expectedKey}'`);
  }
  return edge;
}

/**
 * The dependencyEdges of the manifest in `workspace`, each checked for the keys that S3 reads, the manifest's factory block (resolved: where the factory
 * directory is, for the `<factory>` placeholders of a command) and its state dialect setting.
 * @param {{ fs: typeof import("node:fs") }} io
 * @returns {{ found: boolean, edges: object[], factory: ReturnType<typeof resolveFactory>, stateDialect: string }} `found` is false when the file does not exist
 * @throws {RoutingDataError} when the file exists and cannot be read as a manifest
 */
export function loadManifestEdges(workspace, io) {
  const file = manifestFile(workspace, io);
  let text;
  try {
    text = io.fs.readFileSync(file, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") return { found: false, edges: [], factory: resolveFactory({}), stateDialect: "preserve" };
    throw new RoutingDataError(`${file} cannot be read: ${error.message}`);
  }
  let document;
  try {
    document = YAML.parse(text);
  } catch (error) {
    throw new RoutingDataError(`${file} is not valid YAML: ${error.message}`);
  }
  if (!isObject(document)) throw new RoutingDataError(`${file} is not a mapping`);
  const stateDialect = stateDialectSetting(document, file);
  const raw = document.dependencyEdges ?? [];
  if (!Array.isArray(raw)) throw new RoutingDataError(`${file}: dependencyEdges is not a list`);
  const edges = raw.map((entry, index) => {
    const { valid, errors } = validateShape("ManifestEdge", entry);
    if (!valid) throw new RoutingDataError(`${file}: dependencyEdges[${index}] is not usable: ${errors.join("; ")}`);
    return entry;
  });
  return { found: true, edges, factory: resolveFactory(document), stateDialect };
}

/**
 * The edge whose upstreamSlug is `slug`, read from the manifest in `workspace`, and the manifest's state dialect setting.
 * @returns {{ edge: object | null, reason: string | null, stateDialect: string }} `edge` is null when no entry (or more than one) names the slug
 * @throws {RoutingDataError} when the manifest cannot be read, or the entry that names the slug lacks what S3 needs
 */
export function findEdgeBySlug(workspace, slug, io) {
  const file = manifestFile(workspace, io);
  let text;
  try {
    text = io.fs.readFileSync(file, "utf8");
  } catch (error) {
    throw new RoutingDataError(`${file} cannot be read: ${error.message}`);
  }
  let document;
  try {
    document = YAML.parse(text);
  } catch (error) {
    throw new RoutingDataError(`${file} is not valid YAML: ${error.message}`);
  }
  const stateDialect = stateDialectSetting(document, file);
  const raw = isObject(document) && Array.isArray(document.dependencyEdges) ? document.dependencyEdges : [];
  const matches = raw.filter((entry) => isObject(entry) && entry.upstreamSlug === slug);
  if (matches.length === 0) return { edge: null, reason: `no dependencyEdges entry of ${file} has the upstreamSlug '${slug}'`, stateDialect };
  if (matches.length > 1) return { edge: null, reason: `${matches.length} dependencyEdges entries of ${file} have the upstreamSlug '${slug}'`, stateDialect };
  assertShape("ManifestEdge", matches[0], `the dependencyEdges entry '${slug}'`);
  return { edge: matches[0], reason: null, stateDialect };
}

/** The value that a JSON Pointer (RFC 6901) names in a parsed document, or `undefined`. */
export function resolveJsonPointer(document, pointer) {
  if (pointer === "") return document;
  if (!pointer.startsWith("/")) return undefined;
  let current = document;
  for (const raw of pointer.slice(1).split("/")) {
    const key = raw.replace(/~1/g, "/").replace(/~0/g, "~");
    if (Array.isArray(current)) {
      if (!/^(?:0|[1-9][0-9]*)$/.test(key) || Number(key) >= current.length) return undefined;
      current = current[Number(key)];
    } else if (isObject(current) && Object.hasOwn(current, key)) {
      current = current[key];
    } else {
      return undefined;
    }
  }
  return current;
}
