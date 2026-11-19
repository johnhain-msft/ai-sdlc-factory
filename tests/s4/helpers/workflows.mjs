// The AI adaptation workflows of the preset, as the committed files, with the identities of SPEC-04 AC5 and the small readers that the static tests share.
import YAML from "yaml";
import { presetEdges } from "../../helpers/preset.mjs";
import { abs, readText } from "./fixtures.mjs";
import { customJobsOf, globMatches, parseWorkflow, presetManifest, readWorkflow, referenceRequest, stepWithRun, stepsOf } from "../../s1/helpers/fixtures.mjs";

export { customJobsOf, globMatches, parseWorkflow, presetManifest, readWorkflow, referenceRequest, stepWithRun, stepsOf };

export const WORKFLOW_DIR = ".github/workflows";

const aiEdges = presetEdges().filter((edge) => edge.mode === "ai-adaptation");
/** The downstream that the AI edges of the preset deliver into (the fleet has one). */
export const DOWNSTREAM = aiEdges[0].downstreamRepo;

/** The identities of the preset's AI edges, derived from the manifest: what each edge is called and where its workflow keeps its state. */
export const AI = aiEdges.map((edge) => ({
  edgeId: edge.edgeId,
  id: `cascade-ai-${edge.edgeId}`,
  upstreamKey: edge.upstreamKey,
  upstreamSlug: edge.upstreamSlug,
  upstreamRepo: edge.upstreamRepo,
  repo: edge.upstreamRepo.split("/")[1],
  branchName: edge.branchName,
  closeOlderKey: edge.closeOlderKey,
  group: `sdlc-state-${edge.upstreamKey}`,
  scopes: edge.syncScopes ?? ["both"],
  provenanceFile: edge.provenanceFile,
}));

export const WORKFLOW_IDS = AI.map((spec) => spec.id);
export const ALL_SCOPES = [...new Set(AI.flatMap((spec) => spec.scopes))];

let preset = null;
/** The preset manifest (parsed once). */
export const manifest = () => (preset ??= presetManifest());
/** The preset edge of a workflow spec. */
export const edgeOf = (spec) => manifest().dependencyEdges.find((edge) => edge.edgeId === spec.edgeId);
/** The committed workflow `.md`: parsed frontmatter, its text and the prompt body. */
export const workflowOf = (spec) => readWorkflow(`${spec.id}.md`);
/** The committed compiled workflow. */
export const lockOf = (spec) => YAML.parse(readText(abs(WORKFLOW_DIR, `${spec.id}.lock.yml`)));
export const lockTextOf = (spec) => readText(abs(WORKFLOW_DIR, `${spec.id}.lock.yml`));

/** The text of a rendered shell block of a frontmatter step list, by step name. */
export const stepNamed = (steps, name) => {
  const step = steps.find((candidate) => candidate.name === name);
  if (!step) throw new Error(`no step named '${name}'`);
  return step;
};

/** The custom jobs of the committed source of a workflow. */
export const customJobs = (spec) => customJobsOf(workflowOf(spec).frontmatter.jobs);
