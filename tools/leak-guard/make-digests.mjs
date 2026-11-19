#!/usr/bin/env node
// Owner-run generator for denylist.json (design K.3). Never run in CI, and never pointed at a file inside this repository:
// the terms stay outside it and only their digests come in.
//
//   node tools/leak-guard/make-digests.mjs --terms <file>... [--from-manifest <sdlc.yaml>...] [--from-request <request.json>...]
//        [--out tools/leak-guard/denylist.json] [--max-window 8]
//
// A terms file has one term per line, an optional category after a tab (handle, org, repo, app, host, person, other), and
// "#" comments. --from-manifest harvests every owner, owner/repo, bare repository name and reviewer of a manifest;
// --from-request harvests appSlug. projectKey values are generic words and are not harvested. A term with an at sign is refused: the generic rules
// already stop every e-mail address, and a digest of one under the public prefix would let anyone confirm a candidate address offline.
//
// Every term is normalized by digest.mjs (the code the scanner uses) and stored as a digest with an opaque id (d01, d02, ...)
// and its category. The id of a digest that is already in the output file is kept, so allow-list entries stay valid when the
// list is regenerated. Output keys are sorted so that a diff shows only what changed. The generator prints counts and the
// position of each refused term (file and line), never a term.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { CATEGORIES, DEFAULT_MAX_WINDOW, DEFAULT_PREFIX, FORMAT_VERSION, MAX_WINDOW_LIMIT, MIN_JOINED_LENGTH, digestOfJoined, parseDenylist, tokens } from "./digest.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPOSITORY_ROOT = path.resolve(HERE, "..", "..");
const DEFAULT_OUT = path.join(HERE, "denylist.json");

// The engine's own name: a repository called "ai-sdlc" must not turn "ai-sdlc-factory" into a leak.
const ENGINE_WORDS = new Set(["ai", "sdlc", "factory"]);
// Common words that are also repository names. A bare "portfolio" would flag every honest use of the word, and so would a bare
// pair of them such as "sample-docs"; the qualified form (owner/name) is what belongs in a terms file.
const COMMON_WORDS = new Set(
  `portfolio playground sandbox workshop workshops showcase studio studios intermediate beginner beginners advanced starter template
   templates sample samples example examples demo demos docs documentation website webpage homepage blog notes guide guides tutorial
   tutorials handbook course courses training learning lessons exercises workbook cookbook recipes config configuration settings tools
   tooling toolkit utils utilities library libraries framework frameworks platform platforms service services server servers client
   clients agent agents copilot github gitlab bitbucket pipeline pipelines workflow workflows action actions automation management
   manager managers assets admin administration community communities project projects release releases engine engines orchestrator
   orchestration security compliance governance enterprise organization organizations repository repositories microsoft azure openai
   manufacturing industry feature features design system systems software development developer developers engineering analytics cloud
   internal private public personal official general default production staging testing`
    .split(/\s+/)
    .filter(Boolean),
);

const SLUG = /^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)$/;

/** Parses a terms file into [{ term, category, label }] and a list of problems that name a line, never a term. */
export function parseTerms(text, label) {
  const entries = [];
  const problems = [];
  text.split("\n").forEach((raw, index) => {
    const line = raw.replace(/\r$/, "");
    if (line.trim() === "" || line.trimStart().startsWith("#")) return;
    const [term, category = "other"] = line.split("\t").map((part) => part.trim());
    if (!CATEGORIES.includes(category)) problems.push({ label: `${label}:${index + 1}`, reason: "unknown category" });
    else entries.push({ term, category, label: `${label}:${index + 1}` });
  });
  return { entries, problems };
}

/** Terms from a parsed manifest: reviewers, then every owner/repo with its owner and bare repository name. */
export function harvestManifest(document, label = "manifest") {
  const entries = [];
  const add = (term, category, where) => entries.push({ term, category, label: `${label}:${where}` });
  const reviewers = [];
  const repositories = [];
  const walk = (value, key) => {
    if (Array.isArray(value)) value.forEach((item) => walk(item, key));
    else if (value !== null && typeof value === "object") for (const [childKey, child] of Object.entries(value)) walk(child, childKey);
    else if (typeof value === "string") {
      if (key === "reviewers") reviewers.push(value.replace(/^@/, ""));
      else if ((key === "repo" || key.endsWith("Repo")) && SLUG.test(value)) repositories.push(value);
      else if (key === "owner") add(value, "org", "owner");
    }
  };
  walk(document, "");
  reviewers.forEach((name, index) => add(name, "handle", `reviewer#${index + 1}`));
  const owners = new Set();
  repositories.forEach((slug, index) => {
    const [, owner, name] = SLUG.exec(slug);
    add(slug, "repo", `repository#${index + 1}`);
    add(name, "repo", `repository-name#${index + 1}`);
    owners.add(owner);
  });
  [...owners].forEach((owner, index) => add(owner, "org", `repository-owner#${index + 1}`));
  return entries;
}

export function harvestRequest(document, label = "request") {
  return typeof document?.appSlug === "string" && document.appSlug !== "" ? [{ term: document.appSlug, category: "app", label: `${label}:appSlug` }] : [];
}

/** Why a term cannot go into the denylist (a reason that never quotes the term), or null when it can. */
export function refusalFor(term) {
  // The prefix of a digest is public, so anyone can test a candidate address against it offline; the generic rules already stop every address.
  if (term.includes("@")) return "email address (covered by email-any and microsoft-email rules)";
  const parts = tokens(term);
  const joined = parts.join("");
  if (parts.length === 0) return "no letters or digits";
  if (joined.length < MIN_JOINED_LENGTH) return `shorter than ${MIN_JOINED_LENGTH} characters`;
  if (parts.every((part) => ENGINE_WORDS.has(part))) return "the engine's own name";
  if (COMMON_WORDS.has(joined) || (parts.length <= 2 && parts.every((part) => COMMON_WORDS.has(part)))) {
    return "only common words (use the qualified owner/name form)";
  }
  if (parts.length > MAX_WINDOW_LIMIT) return `more than ${MAX_WINDOW_LIMIT} tokens`;
  return null;
}

/**
 * Builds the denylist document from term entries. `existing` is a parsed previous denylist (runtime form) whose ids are kept
 * for digests that survive. Returns { document, accepted, refused, duplicates }, where refused carries a label and a reason.
 */
export function buildDenylist(entries, { existing = null, maxWindow = DEFAULT_MAX_WINDOW, prefix = DEFAULT_PREFIX } = {}) {
  const refused = [];
  const unique = new Map();
  let duplicates = 0;
  for (const entry of entries) {
    const reason = refusalFor(entry.term);
    if (reason) {
      refused.push({ label: entry.label, reason });
      continue;
    }
    const parts = tokens(entry.term);
    const digest = digestOfJoined(parts.join(""), prefix);
    if (unique.has(digest)) duplicates += 1;
    else unique.set(digest, { category: entry.category, tokenCount: parts.length });
  }
  const window = Math.min(MAX_WINDOW_LIMIT, Math.max(maxWindow, ...[...unique.values()].map((value) => value.tokenCount)));
  const keepIds = existing && existing.prefix === prefix ? existing.byDigest : new Map();
  const used = new Set([...keepIds.values()].map((value) => value.id));
  let next = Math.max(0, ...[...used].map((id) => Number(id.slice(1)))) + 1;
  const digests = {};
  const newcomers = [...unique.keys()].filter((digest) => !keepIds.has(digest)).sort();
  const assigned = new Map(newcomers.map((digest) => [digest, `d${String(next++).padStart(2, "0")}`]));
  for (const digest of [...unique.keys()].sort()) {
    digests[digest] = { id: keepIds.get(digest)?.id ?? assigned.get(digest), category: unique.get(digest).category };
  }
  return { document: { version: FORMAT_VERSION, prefix, maxWindow: window, digests }, accepted: unique.size, refused, duplicates };
}

function isInside(file, root) {
  const relative = path.relative(root, path.resolve(file));
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

const USAGE =
  "usage: node tools/leak-guard/make-digests.mjs --terms <file>... [--from-manifest <sdlc.yaml>...] [--from-request <json>...] [--out <denylist.json>] [--max-window <n>]";

function parseArguments(argv) {
  const options = { terms: [], manifests: [], requests: [], out: DEFAULT_OUT, maxWindow: DEFAULT_MAX_WINDOW, help: false };
  const value = (index, flag) => {
    if (argv[index + 1] === undefined || argv[index + 1].startsWith("--")) throw new Error(`${flag} needs a value`);
    return argv[index + 1];
  };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === "--help" || flag === "-h") options.help = true;
    else if (flag === "--terms") options.terms.push(path.resolve(value(index++, flag)));
    else if (flag === "--from-manifest") options.manifests.push(path.resolve(value(index++, flag)));
    else if (flag === "--from-request") options.requests.push(path.resolve(value(index++, flag)));
    else if (flag === "--out") options.out = path.resolve(value(index++, flag));
    else if (flag === "--max-window") options.maxWindow = Number(value(index++, flag));
    else throw new Error(`unknown argument ${flag}`);
  }
  if (!Number.isInteger(options.maxWindow) || options.maxWindow < 1 || options.maxWindow > MAX_WINDOW_LIMIT) {
    throw new Error(`--max-window must be an integer from 1 to ${MAX_WINDOW_LIMIT}`);
  }
  return options;
}

export async function main(argv, { stdout = process.stdout, stderr = process.stderr, root = REPOSITORY_ROOT } = {}) {
  try {
    const options = parseArguments(argv);
    if (options.help) {
      stdout.write(`${USAGE}\n`);
      return 0;
    }
    const inputs = [...options.terms, ...options.manifests, ...options.requests];
    if (inputs.length === 0) throw new Error("give at least one of --terms, --from-manifest, --from-request");
    for (const input of inputs) {
      if (isInside(input, root)) throw new Error("an input file is inside this repository: keep the terms outside it");
    }
    const entries = [];
    const problems = [];
    for (const file of options.terms) {
      const parsed = parseTerms(fs.readFileSync(file, "utf8"), path.basename(file));
      entries.push(...parsed.entries);
      problems.push(...parsed.problems);
    }
    if (options.manifests.length > 0) {
      const { parse } = await import("yaml");
      for (const file of options.manifests) entries.push(...harvestManifest(parse(fs.readFileSync(file, "utf8")), path.basename(file)));
    }
    for (const file of options.requests) entries.push(...harvestRequest(JSON.parse(fs.readFileSync(file, "utf8")), path.basename(file)));

    let existing = null;
    if (fs.existsSync(options.out)) {
      try {
        existing = parseDenylist(JSON.parse(fs.readFileSync(options.out, "utf8")), { allowEmpty: true });
      } catch (error) {
        // Ids are what allow-list entries point at: regenerating from a damaged file would renumber them silently.
        throw new Error(`the existing output is not a valid denylist (${error.message}); delete it to start again, and review the ids in allow.json`);
      }
    }
    const built = buildDenylist(entries, { existing, maxWindow: options.maxWindow });
    if (built.accepted === 0) throw new Error("no usable terms: refusing to write an empty denylist");
    fs.mkdirSync(path.dirname(options.out), { recursive: true });
    fs.writeFileSync(options.out, `${JSON.stringify(built.document, null, 2)}\n`);

    const perCategory = new Map();
    for (const { category } of Object.values(built.document.digests)) perCategory.set(category, (perCategory.get(category) ?? 0) + 1);
    stdout.write(`make-digests: ${built.accepted} digest(s) written to ${options.out} (maxWindow ${built.document.maxWindow})\n`);
    stdout.write(`  by category: ${[...perCategory].sort().map(([category, count]) => `${category}=${count}`).join(" ")}\n`);
    stdout.write(`  duplicates folded: ${built.duplicates}; refused: ${built.refused.length + problems.length}\n`);
    for (const item of [...problems, ...built.refused]) stdout.write(`  refused ${item.label}: ${item.reason}\n`);
    return 0;
  } catch (error) {
    stderr.write(`make-digests: ${error.message}\n${USAGE}\n`);
    return 2;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  process.exitCode = await main(process.argv.slice(2));
}
