// The minimal fleet, rendered with a change to its manifest: what the tests of the change policy, the engine model and the agent sandbox of an edge need.
import { renderFleet } from "../../../src/reconcile.mjs";
import { minimalManifest, mutate, parseWorkflow, projectOf, referenceRequest, toYaml } from "./fixtures.mjs";
import { createWorkspace } from "./workspace.mjs";

export const CHANGE_POLICIES = ["corrections-only", "corrections-and-additions", "judgement-and-flag"];

/**
 * Renders the minimal fleet (the drift project alpha-service, the edge alpha-to-beta) from its manifest changed by `change`.
 * @returns {{ ok: true, files: Map<string, string>, workflow: (id: string) => ReturnType<typeof parseWorkflow> } | { ok: false, errors: string[] }}
 */
export function renderMinimal(change = () => undefined, request = referenceRequest()) {
  const workspace = createWorkspace({ manifestText: toYaml(mutate(minimalManifest(), change)) });
  try {
    const result = renderFleet(request, { cwd: workspace.dir });
    if (!result.ok) return { ok: false, errors: result.result.validationResults.flatMap((entry) => entry.errors) };
    return { ok: true, files: result.files, workflow: (id) => parseWorkflow(result.files.get(`.github/workflows/${id}.md`)) };
  } finally {
    workspace.cleanup();
  }
}

/** The drift and the implementation workflow of alpha-service under a change policy (undefined: the key is absent), and `change` applied as well. */
export function renderPolicy(changePolicy, change = () => undefined) {
  const rendered = renderMinimal((copy) => {
    if (changePolicy !== undefined) projectOf(copy, "alpha-service").driftAudit.changePolicy = changePolicy;
    change(copy);
  });
  if (!rendered.ok) throw new Error(rendered.errors.join("\n"));
  return { drift: rendered.workflow("drift-alpha-service"), implement: rendered.workflow("implement-alpha-service"), files: rendered.files };
}
