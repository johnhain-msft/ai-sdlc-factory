// The one surface that the scripts of an orchestrator import (design sections E5 and L.1): `ai-sdlc-factory/script-kit`.
//
// A fleet keeps its own helper scripts beside its manifest, for the parts of its pipeline that are its own business (a classifier for a preflight check, a helper
// that reads the downstream's sources). They run in the jobs that the engine renders, and they need the same small set of tools that the engine's scripts use:
// the flags and the process of a script, the manifest, the checkouts and the REST client. This module re-exports exactly those, so that the engine can move
// its internals without breaking a script that only imports from here. Nothing else of src/ is reachable from outside the package: the exports map says so.
//
// Semver applies to this list (tests/api-surface.test.mjs pins it): a name is added in a minor release, and removed only in a major one.

// the flags and the process of a script
export { parseFlags, parseBoolean, requireSlug, repoName, UsageError } from "./drift/lib/args.mjs";
export { resolveIo, runAsMain, workspaceOf, outDirectory, stableJson, BASE_SHA_VARIABLE } from "./drift/lib/cli.mjs";
export { writeFilesAtomically } from "./drift/lib/atomic.mjs";

// the manifest that a helper reads, and its helpers' data
export { readManifest, locateManifest, helperSection, relativePath, resolvePointer, isInside, ManifestError, aiEdges, workflowIdOf } from "./adaptation/manifest.mjs";

// reading TypeScript sources without a compiler
export { scan, matchingBracket, inComment } from "./adaptation/ts-scan.mjs";

// git and checkouts
export { childEnvironment, ensureCheckout, execute, git, isolatedClone, toShellPath } from "./routing/git.mjs";

// the REST client
export { createRestClient, repoPath, encodePath, resolveApiBase, assertInstallationToken, RestError } from "./routing/rest.mjs";
