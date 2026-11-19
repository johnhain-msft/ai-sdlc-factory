// The parts of the fleet manifest that the drift scripts need: the watched URLs, the package manifest patterns and the cited-pages block of one
// project's driftAudit.knowledgeSources (the snapshot script), and the dedupe conventions that apply to it (the dedupe script). The manifest was validated against
// schemas/sdlc.schema.json when it was reconciled; these readers check again what they rely on, so that a damaged file stops the run instead of changing it.

import nodeFs from "node:fs";
import { assertRelativePattern } from "./glob.mjs";
import { loadYaml } from "./yaml-load.mjs";

const KINDS = new Set(["changelog", "blog", "docs", "release-notes", "feed"]);
const HOSTNAME = /^(?=.{1,253}$)[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)+$/;
export const DEFAULT_MAX_CITED_PAGES = 50;
export const MAX_CITED_PAGES = 200;
const isObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);

/** A watched URL: http(s), a literal host (no wildcard) and no credentials. */
export function assertWatchUrl(url) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`the watched URL '${url}' is not a URL`);
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") throw new Error(`the watched URL '${url}' is not an http(s) URL`);
  if (url.includes("*") || parsed.hostname.includes("*")) throw new Error(`the watched URL '${url}' contains a wildcard`);
  if (parsed.username !== "" || parsed.password !== "") throw new Error(`the watched URL '${url}' carries credentials`);
  return parsed.href;
}

/**
 * The optional citedPages block: which files of the target checkout to read (`include`, relative patterns), which hosts count (`hosts`, literal
 * hostnames) and how many of the most cited pages to snapshot (`maxPages`, 1 to 200, default 50); null when the project has none.
 */
function citedPagesOf(value, projectKey) {
  if (value === undefined || value === null) return null;
  if (!isObject(value)) throw new Error(`knowledgeSources.citedPages of '${projectKey}' is not an object`);
  const include = value.include;
  const hosts = value.hosts;
  if (!Array.isArray(include) || include.length === 0) throw new Error(`knowledgeSources.citedPages.include of '${projectKey}' must be a non-empty list`);
  if (!Array.isArray(hosts) || hosts.length === 0) throw new Error(`knowledgeSources.citedPages.hosts of '${projectKey}' must be a non-empty list`);
  const maxPages = value.maxPages ?? DEFAULT_MAX_CITED_PAGES;
  if (!Number.isInteger(maxPages) || maxPages < 1 || maxPages > MAX_CITED_PAGES) throw new Error(`knowledgeSources.citedPages.maxPages of '${projectKey}' must be a whole number from 1 to ${MAX_CITED_PAGES}`);
  return {
    include: include.map((pattern) => {
      if (typeof pattern !== "string") throw new Error(`a citedPages.include entry of '${projectKey}' is not a string`);
      return assertRelativePattern(pattern);
    }),
    hosts: hosts.map((host) => {
      if (typeof host !== "string" || !HOSTNAME.test(host)) throw new Error(`the citedPages host '${String(host)}' of '${projectKey}' is not a literal hostname`);
      return host.toLowerCase();
    }),
    maxPages,
  };
}

/**
 * The manifest document and the entry of one project, read the way every drift reader reads them: a file that cannot be read or parsed, a manifest without a
 * projects list, a project that is missing or listed twice each stop the run with a message that names the file.
 */
async function readManifestProject({ manifestPath, projectKey, fs, parser }) {
  let text;
  try {
    text = fs.readFileSync(manifestPath, "utf8");
  } catch (error) {
    throw new Error(`the manifest '${manifestPath}' cannot be read: ${error.message}`);
  }
  let document;
  try {
    document = await loadYaml(text, { parser });
  } catch (error) {
    throw new Error(`the manifest '${manifestPath}' cannot be parsed: ${error.message}`);
  }
  if (!isObject(document) || !Array.isArray(document.projects)) throw new Error(`the manifest '${manifestPath}' has no projects list`);
  const matches = document.projects.filter((project) => isObject(project) && project.projectKey === projectKey);
  if (matches.length === 0) throw new Error(`the manifest '${manifestPath}' has no project '${projectKey}'`);
  if (matches.length > 1) throw new Error(`the manifest '${manifestPath}' lists the project '${projectKey}' more than once`);
  return { document, project: matches[0] };
}

/**
 * @returns {Promise<{ projectKey: string, repo: string, watchUrls: { url: string, label: string, kind: string }[], packageManifests: string[],
 *   citedPages: { include: string[], hosts: string[], maxPages: number } | null }>}
 */
export async function readProjectSources({ manifestPath, projectKey, fs = nodeFs, parser = "auto" }) {
  const { project } = await readManifestProject({ manifestPath, projectKey, fs, parser });
  const audit = project.driftAudit;
  if (!isObject(audit)) throw new Error(`the project '${projectKey}' has no driftAudit block`);
  const sources = isObject(audit.knowledgeSources) ? audit.knowledgeSources : {};
  const urls = sources.watchUrls ?? [];
  const patterns = sources.packageManifests ?? [];
  if (!Array.isArray(urls)) throw new Error(`knowledgeSources.watchUrls of '${projectKey}' is not a list`);
  if (!Array.isArray(patterns)) throw new Error(`knowledgeSources.packageManifests of '${projectKey}' is not a list`);
  const watchUrls = urls.map((entry, position) => {
    if (!isObject(entry) || typeof entry.url !== "string") throw new Error(`watchUrls[${position}] of '${projectKey}' has no url`);
    assertWatchUrl(entry.url);
    const label = typeof entry.label === "string" ? entry.label : entry.url;
    const kind = typeof entry.kind === "string" ? entry.kind : "docs";
    if (!KINDS.has(kind)) throw new Error(`watchUrls[${position}] of '${projectKey}' has the unknown kind '${kind}'`);
    return { url: entry.url, label, kind };
  });
  const packageManifests = patterns.map((pattern) => {
    if (typeof pattern !== "string") throw new Error(`a packageManifests entry of '${projectKey}' is not a string`);
    return assertRelativePattern(pattern);
  });
  return { projectKey, repo: typeof project.repo === "string" ? project.repo : "", watchUrls, packageManifests, citedPages: citedPagesOf(sources.citedPages, projectKey) };
}

/** A list of non-empty strings (a missing list is empty). */
function stringList(value, label, projectKey) {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw new Error(`${label} of '${projectKey}' is not a list`);
  return value.map((item, position) => {
    if (typeof item !== "string") throw new Error(`${label}[${position}] of '${projectKey}' is not a string`);
    if (item === "") throw new Error(`${label}[${position}] of '${projectKey}' is empty`);
    return item;
  });
}

/** The dedupe block as the script uses it: every upkeep with its prefixes and labels, and the strategy map, each checked again after the schema. */
function dedupeOf(block, projectKey) {
  if (!isObject(block)) throw new Error(`dedupe of '${projectKey}' is not an object`);
  const listed = block.upkeeps ?? [];
  if (!Array.isArray(listed)) throw new Error(`dedupe.upkeeps of '${projectKey}' is not a list`);
  const upkeeps = listed.map((entry, position) => {
    const at = `dedupe.upkeeps[${position}]`;
    if (!isObject(entry)) throw new Error(`${at} of '${projectKey}' is not an object`);
    if (typeof entry.id !== "string" || entry.id === "") throw new Error(`${at} of '${projectKey}' has no id`);
    return { id: entry.id, branchPrefixes: stringList(entry.branchPrefixes, `${at}.branchPrefixes`, projectKey), labels: stringList(entry.labels, `${at}.labels`, projectKey) };
  });
  const map = block.strategyUpkeep ?? {};
  if (!isObject(map)) throw new Error(`dedupe.strategyUpkeep of '${projectKey}' is not an object`);
  const declared = new Set(upkeeps.map((upkeep) => upkeep.id));
  const strategyUpkeep = {};
  for (const [strategy, id] of Object.entries(map)) {
    if (typeof id !== "string" || !declared.has(id)) throw new Error(`dedupe.strategyUpkeep.${strategy} of '${projectKey}' names the upkeep '${String(id)}', which the block does not declare`);
    strategyUpkeep[strategy] = id;
  }
  return { upkeeps, strategyUpkeep };
}

/**
 * The dedupe conventions that apply to one project: its own `driftAudit.dedupe` block, else the fleet's top-level `dedupe` block, else null. A project's
 * block replaces the fleet's, it is not merged with it. Null means that the manifest declares no convention at all.
 * @returns {Promise<{ upkeeps: { id: string, branchPrefixes: string[], labels: string[] }[], strategyUpkeep: Record<string, string> } | null>}
 */
export async function readProjectDedupe({ manifestPath, projectKey, fs = nodeFs, parser = "auto" }) {
  const { document, project } = await readManifestProject({ manifestPath, projectKey, fs, parser });
  const own = isObject(project.driftAudit) ? project.driftAudit.dedupe : undefined;
  const block = own ?? document.dedupe;
  return block === undefined || block === null ? null : dedupeOf(block, projectKey);
}
