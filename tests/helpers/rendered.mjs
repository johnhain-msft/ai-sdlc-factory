// Helpers for tests that read rendered workflows: the frontmatter of a .md file, the steps of every kind of job, and the router.

import YAML from "yaml";

export const WORKFLOWS = ".github/workflows";

/** The YAML frontmatter of a rendered workflow (`---\n<yaml>\n---\n<body>`). */
export const frontmatterOf = (text) => YAML.parse(/^---\n([\s\S]*?)\n---\n/.exec(text)[1]);

/** The markdown body of a rendered workflow. */
export const bodyOf = (text) => text.slice(/^---\n[\s\S]*?\n---\n/.exec(text)[0].length).replace(/^\n+/, "");

/** `{ id, text, fm }` for every rendered .md workflow (not the router, not aw.json). */
export function workflowsOf(files) {
  return [...files.entries()]
    .filter(([file]) => file.startsWith(`${WORKFLOWS}/`) && file.endsWith(".md"))
    .map(([file, text]) => ({ id: file.slice(WORKFLOWS.length + 1, -".md".length), file, text, fm: frontmatterOf(text) }));
}

export const routerOf = (files) => YAML.parse(files.get(`${WORKFLOWS}/cascade-router.yml`));

/** Every step that a workflow runs on its own account, with where it is: the steps of the agent job and of its custom jobs. */
export function stepsOf(fm) {
  const found = [];
  for (const key of ["pre-steps", "steps", "pre-agent-steps", "post-steps"]) {
    for (const [index, step] of (fm[key] ?? []).entries()) found.push({ where: key, index, step });
  }
  for (const [name, job] of Object.entries(fm.jobs ?? {})) {
    for (const [index, step] of (job?.steps ?? []).entries()) found.push({ where: `jobs.${name}`, index, step });
  }
  return found;
}

/** Every step of the router workflow. */
export const routerSteps = (router) => Object.entries(router.jobs).flatMap(([name, job]) => (job.steps ?? []).map((step, index) => ({ where: `jobs.${name}`, index, step })));

export const named = (steps, name) => steps.find((step) => step.name === name);
