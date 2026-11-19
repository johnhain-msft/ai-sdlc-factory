// ai-sdlc-factory/reconcile: the public surface of the renderer and the reconciler (design L.1), four functions and nothing else.
//
// The exports map publishes this file and not src/reconcile.mjs. That module also exports the names that the package's own commands and tools need (main() for
// bin/sdlc-reconcile.mjs, ghAwEnvironment() for the real compiler, renderOnboardPayload(), the two generated paths): they are reached by the relative path of
// that module and are not semver-governed. tests/api-surface.test.mjs pins both lists.

export { buildAcks, checkRendered, reconcile, renderFleet } from "./reconcile.mjs";
