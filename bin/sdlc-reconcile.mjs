#!/usr/bin/env node
// sdlc-reconcile --request <file>
//
// Renders the fleet workflows from the manifest that the request names, compiles them with `gh aw compile --strict` and rolls every file back when
// anything fails. The request is the nine-key BootstrapReconcileRequest (a JSON file); the result, a ReconcileResult, is printed as JSON, and the exit
// code is 0 for ok and 1 otherwise. Run it from the root of the repository whose workflows are generated: `npx sdlc-reconcile --request <file>`.

import { main } from "../src/reconcile.mjs";

await main(process.argv.slice(2));
