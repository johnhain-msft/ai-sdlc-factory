#!/usr/bin/env node
// Second pre-agent step of every drift workflow, and third of every implementation workflow: open pull request deduplication (SPEC-02 AC10, AC26,
// AC32, AC45).
//
//   node src/drift/dedupe-open-prs.mjs --out /tmp/gh-aw/agent --target-repo "$CONFIGURED_TARGET_REPO" \
//     --close-older-key "<the close-older-key of this workflow>" --upkeep-strategy "<its upkeepStrategy>" --project "<its projectKey>"
//   node src/drift/dedupe-open-prs.mjs --out /tmp/gh-aw/agent --target-repo "$CONFIGURED_TARGET_REPO" \
//     --upkeep-strategy "<the upkeepStrategy of the project>" --implementation --project "<its projectKey>"
//
// The target repository is --target-repo, else CONFIGURED_TARGET_REPO. The script lists the open pull requests of the
// target with `GET /repos/{owner}/{repo}/pulls?state=open&per_page=30` (further pages when the repository has more) and
// records those whose head branch starts with sdlc/ (the engine's own) or with a branch prefix that the project's dedupe conventions declare, or that
// carry a label that they declare, in <out>/open-pr-dedup.json (and the same content in <out>/open-prs.json). The agent reads that file before it calls
// create_pull_request.
//
// The conventions are the `dedupe` block of the manifest: the project's own (driftAudit.dedupe), else the fleet's. The manifest is the one that
// SDLC_MANIFEST names in the workspace (sdlc.yaml when it is not set). A block lists the upkeeps of the target's own scheduled workflows, each with its id,
// the branch prefixes and the labels that mark a pull request as that upkeep's, and which upkeep each upkeepStrategy does (strategyUpkeep). Without --project, or
// when the manifest declares no block, nothing is known about the target's own schedules and only the engine's sdlc/ branches are candidates. A manifest that
// cannot be read, or that has no such project, fails the step: an unknown state is never "no duplicate".
//
// `sdlc/*` is every pull request of the orchestrator (every drift workflow of every project that has the same target repository), so a match
// does not always make a duplicate. Each match therefore says whose it is and what this workflow does about it:
//  - belongsTo "current-workflow": the body carries the marker `<!-- gh-aw-close-key: <key> -->` that gh-aw embeds for this workflow's
//    --close-older-key. It is an earlier pull request of this workflow, which stays open (`close-older-pull-requests: false`, SPEC-02 AC25): its
//    items are in this run's baseline, so the new pull request carries other ones. decision "ignore": no reason to skip.
//  - belongsTo "implementation": the workflow is known (--close-older-key or --implementation is given) and the head branch is
//    sdlc/implement-report-<number>, the pull request that implements a drift report (SPEC-02 AC45). Its items are those of that report, which a
//    drift run does not list again and another report does not list at all. decision "ignore".
//  - with --implementation (the workflow implements one drift report, SPEC-02 AC45), every other sdlc/* match is a pull request of the fleet, which
//    carries other items than the report: decision "ignore". The rule below then decides only the target's own scheduled pull requests.
//  - belongsTo "another-workflow-or-schedule": any other match, which is a pull request of another workflow of the orchestrator or of the
//    target's own scheduled workflows. Its `upkeep` is the id of the declared upkeep whose branch prefix or label it carries (the only one: a pull request
//    that two upkeeps claim has none), else null. decision "ignore" when both it and this workflow have an upkeep and the two differ (a self-improvement
//    pull request is no duplicate of a content audit; this workflow's upkeep follows from --upkeep-strategy through the block's strategyUpkeep), else
//    "skip": what is not known to be another upkeep counts as the same.
// `duplicate` is true when some match has the decision "skip", and then the agent does not call create_pull_request. Without
// --close-older-key, --implementation and --upkeep-strategy nothing is known about this workflow and every match is "skip".
//
// Authentication is a GitHub App installation token: GH_APP_INSTALLATION_TOKEN when the caller minted one, else the
// script signs a JSON Web Token with APP_CLIENT_ID and APP_PRIVATE_KEY and exchanges it for a token that is limited to the
// target repository and to read access to its pull requests. A token that is not an App installation token (a personal access token, an
// OAuth token, a user access token of an App) is refused before any request. The API address is
// GITHUB_API_URL (or --api-url). Requests are serial and a rate-limited response is retried as the server states; when it
// stays limited, or anything else goes wrong, the step exits 1 and writes nothing: an unknown state is never "no duplicate".
// The script sends this one read and, for an App credential, the token request; it writes nothing to the target.

import path from "node:path";
import { manifestPathIn } from "../lib/manifest-location.mjs";
import { parseFlags, requireSlug, UsageError } from "./lib/args.mjs";
import { mintInstallationToken } from "./lib/app-token.mjs";
import { writeFilesAtomically } from "./lib/atomic.mjs";
import { outDirectory, resolveIo, runAsMain, stableJson, workspaceOf } from "./lib/cli.mjs";
import { assertInstallationToken, createGitHubClient, GitHubApiError, resolveApiBase } from "./lib/github-client.mjs";
import { readProjectDedupe } from "./lib/manifest.mjs";

const OPTIONS = {
  out: { type: "string" },
  "target-repo": { type: "string" },
  "close-older-key": { type: "string" },
  "upkeep-strategy": { type: "string" },
  project: { type: "string" },
  implementation: { type: "boolean" },
  "api-url": { type: "string" },
  "max-retries": { type: "string" },
  "max-wait-seconds": { type: "string" },
};

/** The branch family of the orchestrator's own pull requests (the renderer's branch prefix): the one convention that the engine keeps for itself. */
export const ENGINE_BRANCH_PREFIX = "sdlc/";
export const QUERY = (owner, repo) => `/repos/${owner}/${repo}/pulls?state=open&per_page=30`;

/** The head branch of the pull request that implements drift report <number> (SPEC-02 AC45). */
export const IMPLEMENTATION_HEAD = /^sdlc\/implement-report-[1-9][0-9]*$/;

/**
 * The conventions of a project's own schedules, from the manifest's `dedupe` block (readProjectDedupe): null (or absent) means that none are declared.
 * @typedef {{ upkeeps: { id: string, branchPrefixes: string[], labels: string[] }[], strategyUpkeep: Record<string, string> } | null | undefined} DedupeConfig
 */

/** The declared branch prefixes, in order and once each, without the ones that the engine's own prefix already covers (a branch gets one reason, not two). */
const declaredPrefixes = (config) => [...new Set((config?.upkeeps ?? []).flatMap((upkeep) => upkeep.branchPrefixes))].filter((prefix) => !prefix.startsWith(ENGINE_BRANCH_PREFIX));
const declaredLabels = (config) => [...new Set((config?.upkeeps ?? []).flatMap((upkeep) => upkeep.labels))];

/** The upkeep that a strategy does, from the block's strategyUpkeep; any other strategy has no upkeep of the target's own schedules to tell apart. */
export const upkeepOfStrategy = (config, strategy) => (Object.hasOwn(config?.strategyUpkeep ?? {}, strategy) ? config.strategyUpkeep[strategy] : null);

/**
 * Why a pull request counts as a possible duplicate: [] when it does not.
 * @param {object} pull
 * @param {DedupeConfig} [config]
 */
export function matchReasons(pull, config = null) {
  const reasons = [];
  const ref = String(pull?.head?.ref ?? "");
  for (const prefix of [...declaredPrefixes(config), ENGINE_BRANCH_PREFIX]) {
    if (ref.startsWith(prefix)) reasons.push(`head branch matches ${prefix}*`);
  }
  const labels = (Array.isArray(pull?.labels) ? pull.labels : []).map((label) => String(label?.name ?? ""));
  for (const label of declaredLabels(config)) if (labels.includes(label)) reasons.push(`carries the label ${label}`);
  return reasons;
}

/** A close-older key as gh-aw writes it into the marker of a pull request body (generate_footer.cjs: lower case, runs of other characters are one dash). */
export function normalizeCloseOlderKey(key) {
  return String(key ?? "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^[-_]+|[-_]+$/g, "");
}

/** Whether a pull request is an earlier pull request of the workflow whose close-older key is given: its body carries gh-aw's marker for that key. */
export function belongsToWorkflow(pull, closeOlderKey) {
  const key = normalizeCloseOlderKey(closeOlderKey);
  return key !== "" && String(pull?.body ?? "").includes(`<!-- gh-aw-close-key: ${key} -->`);
}

/**
 * The upkeep that a pull request is for: the id of the declared upkeep whose branch prefix its head branch starts with or whose label it carries. A pull request
 * that two upkeeps claim, or that none does, has none (null).
 * @param {object} pull
 * @param {DedupeConfig} [config]
 */
export function upkeepOf(pull, config = null) {
  const ref = String(pull?.head?.ref ?? "");
  const labels = new Set((Array.isArray(pull?.labels) ? pull.labels : []).map((label) => String(label?.name ?? "")));
  const found = new Set();
  for (const upkeep of config?.upkeeps ?? []) {
    if (upkeep.branchPrefixes.some((prefix) => ref.startsWith(prefix)) || upkeep.labels.some((label) => labels.has(label))) found.add(upkeep.id);
  }
  return found.size === 1 ? [...found][0] : null;
}

/**
 * What the workflow does about a match: "ignore" (its own earlier pull request, which stays open with other items, the pull request of another
 * upkeep or of the fleet, or the implementation of a drift report) or "skip" (a possible duplicate: the agent does not call create_pull_request).
 * @param {object} pull a pull request of the list
 * @param {{ closeOlderKey: string | null, upkeep: string | null, implementation?: boolean, config?: DedupeConfig }} workflow
 */
export function decide(pull, workflow) {
  const upkeep = upkeepOf(pull, workflow.config);
  if (workflow.closeOlderKey !== null && belongsToWorkflow(pull, workflow.closeOlderKey)) return { belongsTo: "current-workflow", upkeep, decision: "ignore" };
  const head = String(pull?.head?.ref ?? "");
  const known = workflow.closeOlderKey !== null || workflow.implementation === true;
  if (known && IMPLEMENTATION_HEAD.test(head)) return { belongsTo: "implementation", upkeep, decision: "ignore" };
  if (workflow.implementation === true && head.startsWith(ENGINE_BRANCH_PREFIX)) return { belongsTo: "another-workflow-or-schedule", upkeep, decision: "ignore" };
  const other = workflow.upkeep !== null && upkeep !== null && upkeep !== workflow.upkeep;
  return { belongsTo: "another-workflow-or-schedule", upkeep, decision: other ? "ignore" : "skip" };
}

function positiveInteger(value, label, fallback) {
  if (value === undefined) return fallback;
  const number = Number(value);
  if (!Number.isInteger(number) || number < 0) throw new UsageError(`${label} must be a whole number of at least 0`);
  return number;
}

/** @returns {Promise<number>} the exit code */
export async function run(argv, ioInput = {}) {
  const io = resolveIo(ioInput);
  try {
    const flags = parseFlags(argv, OPTIONS);
    const target = requireSlug(flags["target-repo"] ?? io.env.CONFIGURED_TARGET_REPO, "the target repository (--target-repo or CONFIGURED_TARGET_REPO)");
    const [owner, repo] = target.split("/");
    // What this workflow is: the key under which gh-aw marks its pull requests, and its upkeep. Both are optional; without them every match is a possible duplicate.
    const closeOlderKey = flags["close-older-key"] === undefined || flags["close-older-key"].trim() === "" ? null : normalizeCloseOlderKey(flags["close-older-key"]);
    if (closeOlderKey === "") throw new UsageError("--close-older-key must contain a letter or a digit");
    const strategy = String(flags["upkeep-strategy"] ?? "").trim();
    const implementation = flags.implementation === true;
    if (implementation && closeOlderKey !== null) throw new UsageError("--implementation and --close-older-key name two different workflows; give one of them");
    // The conventions of the project's own schedules, from the manifest of the workspace. They are read before anything is asked of the network, and a manifest
    // that cannot be read stops the step: without them every pull request of another upkeep would count as a duplicate or none would.
    const projectKey = flags.project === undefined ? null : flags.project.trim();
    if (projectKey === "") throw new UsageError("--project must name a project of the manifest");
    const config = projectKey === null ? null : await readProjectDedupe({ manifestPath: manifestPathIn(workspaceOf(io), io.env), projectKey, fs: io.fs });
    const workflow = { closeOlderKey, upkeep: upkeepOfStrategy(config, strategy), implementation, config };
    const baseUrl = resolveApiBase({ GITHUB_API_URL: flags["api-url"] ?? io.env.GITHUB_API_URL });
    const out = path.resolve(io.cwd, outDirectory(flags.out, io.env));
    const client = createGitHubClient({
      baseUrl,
      fetch: io.fetch,
      sleep: io.sleep,
      now: io.now,
      maxRateLimitRetries: positiveInteger(flags["max-retries"], "--max-retries", 3),
      maxWaitMs: positiveInteger(flags["max-wait-seconds"], "--max-wait-seconds", 300) * 1000,
    });

    let token = String(io.env.GH_APP_INSTALLATION_TOKEN ?? "").trim();
    if (token !== "") {
      assertInstallationToken(token, "GH_APP_INSTALLATION_TOKEN");
    } else {
      const clientId = String(io.env.APP_CLIENT_ID ?? "").trim();
      const privateKeyPem = String(io.env.APP_PRIVATE_KEY ?? "");
      if (clientId === "" || privateKeyPem.trim() === "") {
        throw new GitHubApiError("no GitHub App credential: set APP_CLIENT_ID and APP_PRIVATE_KEY (or GH_APP_INSTALLATION_TOKEN)");
      }
      token = await mintInstallationToken({
        client,
        clientId,
        privateKeyPem,
        owner,
        repo,
        permissions: { pull_requests: "read" },
        nowMs: io.now(),
      });
    }

    const { items, truncated } = await client.paginate(QUERY(owner, repo), { bearer: token });
    const matches = [];
    for (const pull of items) {
      const reasons = matchReasons(pull, config);
      if (reasons.length === 0) continue;
      matches.push({
        number: pull.number,
        headRef: String(pull.head?.ref ?? ""),
        url: String(pull.html_url ?? ""),
        draft: pull.draft === true,
        labels: (Array.isArray(pull.labels) ? pull.labels : []).map((label) => String(label?.name ?? "")).sort(),
        reasons,
        ...decide(pull, workflow),
      });
    }
    matches.sort((a, b) => a.number - b.number);
    const count = (decision) => matches.filter((match) => match.decision === decision).length;
    const report = stableJson({
      version: 1,
      repository: target,
      query: `GET ${QUERY(owner, repo)}`,
      inspected: items.length,
      truncated,
      closeOlderKey: workflow.closeOlderKey,
      implementation: workflow.implementation,
      upkeep: workflow.upkeep,
      duplicate: count("skip") > 0,
      matches,
    });
    writeFilesAtomically(
      [
        { path: path.join(out, "open-pr-dedup.json"), data: report },
        { path: path.join(out, "open-prs.json"), data: report },
      ],
      { fs: io.fs },
    );
    io.stdout(`dedupe-open-prs: ${items.length} open pull request(s) of ${target} inspected${truncated ? " (more exist than were read)" : ""}, ${matches.length} possible duplicate(s) recorded in ${path.join(out, "open-pr-dedup.json")} (${count("skip")} to skip for, ${count("ignore")} that are no reason to skip)\n`);
    return 0;
  } catch (error) {
    io.stderr(`dedupe-open-prs: ${error.message}\n`);
    return error instanceof UsageError ? 2 : 1;
  }
}

await runAsMain(import.meta.url, run);
