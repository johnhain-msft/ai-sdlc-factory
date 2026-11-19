// Reading the fleet manifest for what S5 needs (edges, projects, deconfliction options). S5 never validates the
// manifest against the schema itself: S1 owns that (contract C1); these checks only keep S5 from acting on a
// document it cannot interpret.

import fs from "node:fs";
import YAML from "yaml";
import { SdlcError } from "./errors.mjs";
import { DEFAULT_PROVENANCE_NAMES } from "./inspect-repo.mjs";
import { isRepoSlug } from "./validators.mjs";

/**
 * A file name that onboarding.provenanceNames may hold: the base name of a file, with no directory part and not . or .., of plain name characters. One pattern, which
 * schemas/sdlc.schema.json repeats for the same list; a test holds the two equal.
 */
export const PROVENANCE_NAME = /^(?!\.{1,2}$)[A-Za-z0-9_.@+-]{1,100}$/;

/**
 * The base names that the onboarding inspection takes for a provenance file: `onboarding.provenanceNames` of the manifest, or the names of the engine when the manifest
 * has none. S1 validates the block against the schema; this only keeps S5 from searching with something that is not a list of file names, and it names the place in
 * the manifest and not the value.
 */
export function provenanceNamesOf(manifest, label = "the manifest") {
  const block = manifest.onboarding;
  if (block === undefined) return DEFAULT_PROVENANCE_NAMES;
  if (block === null || typeof block !== "object" || Array.isArray(block)) throw new SdlcError(`${label}: 'onboarding' must be a mapping`, { code: "manifest" });
  const names = block.provenanceNames;
  if (names === undefined) return DEFAULT_PROVENANCE_NAMES;
  if (!Array.isArray(names)) throw new SdlcError(`${label}: 'onboarding.provenanceNames' must be an array of file names`, { code: "manifest" });
  names.forEach((name, position) => {
    if (typeof name !== "string" || !PROVENANCE_NAME.test(name)) {
      throw new SdlcError(`${label}: 'onboarding.provenanceNames[${position}]' must be a file name (1 to 100 of letters, digits and . _ @ + -, with no directory part, not . or ..)`, { code: "manifest" });
    }
  });
  return [...names];
}

/** Reads and parses the manifest; returns { text, data }. */
export function readManifest(absolutePath, displayPath = absolutePath) {
  let text;
  try {
    text = fs.readFileSync(absolutePath, "utf8");
  } catch (error) {
    throw new SdlcError(`${displayPath} cannot be read: ${error.message}`, { code: "manifest" });
  }
  const document = YAML.parseDocument(text.replace(/^\uFEFF/, ""));
  if (document.errors.length > 0) {
    throw new SdlcError(`${displayPath} is not valid YAML: ${document.errors[0].message.split("\n")[0]}`, { code: "manifest" });
  }
  const data = document.toJS({ maxAliasCount: 200 });
  if (data === null || typeof data !== "object" || Array.isArray(data) || !Array.isArray(data.projects)) {
    throw new SdlcError(`${displayPath} is not a fleet manifest: it needs a 'projects' array (src/reconcile.mjs validates the rest)`, { code: "manifest" });
  }
  if (data.dependencyEdges !== undefined && !Array.isArray(data.dependencyEdges)) {
    throw new SdlcError(`${displayPath}: 'dependencyEdges' must be an array`, { code: "manifest" });
  }
  return { text, data };
}

/** The dependency edges that carry what the bootstrap needs to seed their state variables. */
export function stateEdges(manifest) {
  const edges = manifest.dependencyEdges ?? [];
  for (const edge of edges) {
    if (edge === null || typeof edge !== "object") throw new SdlcError("dependencyEdges holds an entry that is not a mapping", { code: "manifest" });
    if (!isRepoSlug(edge.downstreamRepo)) throw new SdlcError(`dependencyEdges entry '${edge.edgeId ?? "?"}' has no valid downstreamRepo`, { code: "manifest" });
  }
  return edges;
}
