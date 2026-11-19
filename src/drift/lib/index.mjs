// `ai-sdlc-factory/drift-lib`: the modules of src/drift/lib that are safe to stage (design section E5, L.1).
//
// A validator that runs after the agent is compared with a read-only copy before it runs (prepare-run stages it, see src/drift/prepare-run.mjs), and it may import
// the engine only through this barrel: the staged tree is `src/drift/lib/**` and the package's package.json, so what is compared is what is imported. For that
// reason every module below imports nothing but `node:` modules and its siblings in this directory (tests/api-surface.test.mjs checks it), and no module that
// needs the network, a credential or another part of src/ is listed.

export * from "./args.mjs";
export * from "./cli.mjs";
export * from "./atomic.mjs";
export * from "./git-artifacts.mjs";
export * from "./correlation.mjs";
export * from "./yaml-load.mjs";
