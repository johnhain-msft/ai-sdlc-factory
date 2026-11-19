#!/usr/bin/env node
// Leak guard scanner (design K): the generic rules of rules.mjs plus the digest denylist of denylist.json, over the tracked
// tree (--tree), over every added and removed line of every commit (--history), or as counts per rule (--report).
//
//   node tools/leak-guard/scan.mjs [--tree] [--history] [--report] [--root <dir>] [--denylist <file>] [--allow <file>]
//
// A finding is a position and a rule: `path:line:col-col rule=<id>` (a digest hit adds `id=dNN category=<category>`). Line 0 is
// the file path itself. The scanner never prints the text that matched, and it masks any matched text inside a printed path,
// so a CI log cannot leak what the guard found. Exit codes: 0 clean (or --report), 1 findings or a stale allow entry, 2 usage
// or configuration error (including an empty denylist).
//
// A line is searched as it is, joined to the line before it across the break (a term that a line break cut), and decoded (percent-encoding,
// backslash escapes and HTML entities, see decode.mjs): a hit that only a decoded line has covers the whole line, because the decoded text has
// no positions in this one. A binary file is read for its printable strings (extractStrings), each of which is a line, and a binary change in the
// history is read from the strings of its two blobs.
//
// History mode reads two kinds of object that a push publishes: every commit (its diff, message, author and committer) and every
// tag (the name of each tag ref and, for an annotated tag, the tag object's own name, tagger and message, which `git log` never
// shows). Their pseudo-paths are commit:author, commit:committer, commit:subject, commit:body and tag:name, tag:tagger,
// tag:message; a finding in a tag names the tag object (or, for a lightweight tag, the commit) by the first ten characters of
// its id (`tag=<id>`), never by its name, because the name can be the leak.
import fs from "node:fs";
import path from "node:path";
import { execFile, execFileSync, spawn } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { decodedVariants } from "./decode.mjs";
import { digestHits, loadDenylist } from "./digest.mjs";
import { findRuleHits, HARD_RULE_IDS } from "./rules.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const DEFAULT_ROOT = path.resolve(HERE, "..", "..");
export const DEFAULT_DENYLIST = path.join(HERE, "denylist.json");
export const DEFAULT_ALLOW = path.join(HERE, "allow.json");

// Test vectors may live here: the generic rules skip this tree, the digest rules never do.
const FIXTURE_PREFIX = "tests/fixtures/leak-guard/";
// A digest rule may never be waived for code that ships or for tests: only for metadata such as package.json.
const NO_DIGEST_ALLOW_UNDER = ["src/", "bin/", "schemas/", "prompts/", "examples/", "tests/"];
const COMMIT_PATHS = ["commit:author", "commit:committer", "commit:subject", "commit:body"];
const TAG_PATHS = ["tag:name", "tag:tagger", "tag:message"];
const HISTORY_PATHS = [...COMMIT_PATHS, ...TAG_PATHS];
const isHistoryPath = (value) => typeof value === "string" && (value.startsWith("commit:") || value.startsWith("tag:"));

const isFixturePath = (file) => file.startsWith(FIXTURE_PREFIX);
export const topDirectory = (file) =>
  file.startsWith("commit:") ? "(commit metadata)" : file.startsWith("tag:") ? "(tag metadata)" : file.includes("/") ? file.split("/")[0] : "(root)";

// ---------------------------------------------------------------------------------------------------------------------
// Reading files
// ---------------------------------------------------------------------------------------------------------------------

/** Text of a buffer, or null for a binary file. A UTF-16 byte-order mark is decoded rather than skipped as "binary". */
export function decodeText(buffer) {
  if (buffer.length >= 2 && buffer[0] === 0xff && buffer[1] === 0xfe) return buffer.subarray(2).toString("utf16le");
  if (buffer.length >= 2 && buffer[0] === 0xfe && buffer[1] === 0xff) {
    const even = buffer.subarray(2, 2 + ((buffer.length - 2) & ~1));
    return Buffer.from(even).swap16().toString("utf16le");
  }
  if (buffer.includes(0)) return null;
  const text = buffer.toString("utf8");
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

// A binary file is not skipped: what is printable in it is read as strings, as the `strings` tool does. A string is a run of at least four printable
// characters: a tab, a character of ASCII, or any other character that UTF-8 decodes to, ended by a byte that is none of these. UTF-16LE text of the ASCII
// range (a character then a zero byte) is read the same way, whatever its alignment; the last character of a string that a single zero byte ends can be
// taken for the first one of a UTF-16LE string that follows it, which a term does not mind (it is found with a letter glued to it). The UTF-8 and ASCII
// strings come first, then the UTF-16LE ones.
const MIN_STRING = 4;
const UTF8_STRING = new RegExp(`[\\t\\x20-\\x7e\\u00a0-\\ufffc\\u{10000}-\\u{10ffff}]{${MIN_STRING},}`, "gu");
const UTF16LE_STRING = new RegExp(`(?:[\\t\\x20-\\x7e]\\x00){${MIN_STRING},}`, "g");

/** The strings of a binary buffer: the printable runs of four or more characters, UTF-8 or ASCII first and UTF-16LE after, each in the order of the file. */
export function extractStrings(buffer) {
  const strings = buffer.toString("utf8").match(UTF8_STRING) ?? [];
  for (const run of buffer.toString("latin1").matchAll(UTF16LE_STRING)) strings.push(run[0].replace(/(.)\x00/gs, "$1"));
  return strings;
}

function walk(root, relative = "") {
  const found = [];
  for (const entry of fs.readdirSync(path.join(root, relative), { withFileTypes: true })) {
    if (entry.name === ".git" || entry.name === "node_modules" || entry.isSymbolicLink()) continue;
    const next = relative === "" ? entry.name : `${relative}/${entry.name}`;
    if (entry.isDirectory()) found.push(...walk(root, next));
    else if (entry.isFile()) found.push(next);
  }
  return found;
}

/** Tracked files (git ls-files) of a checkout, or every file under a plain directory (an extracted archive). */
export function listFiles(root) {
  if (fs.existsSync(path.join(root, ".git"))) {
    const output = execFileSync("git", ["ls-files", "-z"], { cwd: root, encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });
    return output.split("\0").filter(Boolean).sort();
  }
  return walk(root).sort();
}

// ---------------------------------------------------------------------------------------------------------------------
// Findings
// ---------------------------------------------------------------------------------------------------------------------

function hitsOf(text, { path: file, denylist, generic, isPath = false }) {
  const hits = [];
  if (generic) {
    for (const hit of findRuleHits(text, { path: file, isPath })) hits.push({ ...hit, key: hit.rule });
  }
  for (const hit of digestHits(text, denylist)) {
    hits.push({ rule: "digest", key: `digest:${hit.id}`, kind: "hard", start: hit.start, end: hit.end, id: hit.id, category: hit.category });
  }
  return hits;
}

/**
 * The hits of one line, or of one path: those of the line as it is, then those that only its decoded spellings have (percent-encoding, escapes, entities; see
 * decode.mjs). A decoded line has no positions in this one, so such a hit covers the whole line, and a hard one is reported as many times as the decoded
 * lines hold it more often than the line itself does, so that a leak that the line spells out is not reported twice.
 */
function lineHits(text, context) {
  if (!/\S/.test(text)) return [];
  const hits = hitsOf(text, context);
  const variants = decodedVariants(text);
  if (variants.length === 0) return hits;
  const known = new Map();
  for (const hit of hits) known.set(hit.key, (known.get(hit.key) ?? 0) + 1);
  const more = [];
  for (const variant of variants) {
    const counted = new Map();
    for (const hit of hitsOf(variant, context)) {
      if (hit.kind !== "hard") continue;
      const count = (counted.get(hit.key) ?? 0) + 1;
      counted.set(hit.key, count);
      if (count > (known.get(hit.key) ?? 0)) {
        known.set(hit.key, count);
        more.push({ ...hit, start: 0, end: text.length });
      }
    }
  }
  return more.length === 0 ? hits : [...hits, ...more];
}

function makeFinding(file, line, hit, extra = {}) {
  const finding = { path: file, line, start: hit.start + 1, end: hit.end, rule: hit.rule, key: hit.key, kind: hit.kind, status: "fail", ...extra };
  if (hit.id) {
    finding.id = hit.id;
    finding.category = hit.category;
  }
  return finding;
}

/** The findings of the strings of a binary file: each string is a line, and its number is its place among the strings. */
function stringFindings(file, strings, denylist, extra = {}) {
  const generic = !isFixturePath(file);
  const findings = [];
  strings.forEach((text, index) => {
    for (const hit of lineHits(text, { path: file, denylist, generic })) findings.push(makeFinding(file, index + 1, hit, extra));
  });
  return findings;
}

function pathFindings(file, denylist, extra = {}) {
  const hits = lineHits(file, { path: file, denylist, generic: !isFixturePath(file), isPath: true });
  return hits.filter((hit) => hit.kind === "hard").map((hit) => makeFinding(file, 0, hit, extra));
}

// A line break can cut a term in two. The end of a line and the start of the next one are joined with nothing between them, so that a word that was cut,
// or that a formatter wrapped, is one token again and two words are two tokens as before, and what crosses the break is looked for: the digest windows
// and the generic rules. A hyphen at the end of the first line is dropped in a second join, for the rules (a word that was hyphenated). A hit that lies
// in one line is not reported again: it was found when that line was scanned. A crossing hit is reported on the line where it ends, over the part that
// is on that line. Only two lines are joined, so a term that three lines cut stays unseen, and a blank line is a wall.
const BOUNDARY_CHARS = 96;
const WORD = /[\p{L}\p{N}]/u;

function boundaryHits(previous, line, { path: file, denylist, generic }) {
  const tail = previous.slice(-BOUNDARY_CHARS);
  const head = line.slice(0, BOUNDARY_CHARS);
  if (!WORD.test(tail) || !WORD.test(head)) return [];
  const hits = [];
  const seen = new Set();
  const add = (hit, cut) => {
    const end = Math.min(Math.max(hit.end - cut, 1), line.length);
    const id = `${hit.key}:${end}`;
    if (seen.has(id)) return;
    seen.add(id);
    hits.push({ ...hit, start: 0, end });
  };
  const joins = [{ text: tail + head, cut: tail.length, digests: true }];
  if (generic && tail.endsWith("-")) joins.push({ text: tail.slice(0, -1) + head, cut: tail.length - 1, digests: false });
  for (const { text, cut, digests } of joins) {
    if (generic) {
      for (const hit of findRuleHits(text, { path: file })) {
        if (hit.kind === "hard" && hit.start < cut && cut < hit.end) add({ ...hit, key: hit.rule }, cut);
      }
    }
    if (!digests) continue;
    for (const hit of digestHits(text, denylist, { split: cut })) {
      add({ rule: "digest", key: `digest:${hit.id}`, kind: "hard", start: hit.start, end: hit.end, id: hit.id, category: hit.category }, cut);
    }
  }
  return hits;
}

/** The findings across the break between two adjacent lines, reported on the second one, which is line number `number`. */
function pairFindings(file, previous, line, number, denylist, extra = {}) {
  return boundaryHits(previous, line, { path: file, denylist, generic: !isFixturePath(file) }).map((hit) => makeFinding(file, number, hit, extra));
}

/** The findings of the lines of one text, line by line and across each break between two lines. */
function textFindings(file, text, denylist, extra = {}) {
  const generic = !isFixturePath(file);
  const findings = [];
  const lines = text.split("\n").map((line) => (line.endsWith("\r") ? line.slice(0, -1) : line));
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    for (const hit of lineHits(line, { path: file, denylist, generic })) findings.push(makeFinding(file, index + 1, hit, extra));
    if (index > 0) findings.push(...pairFindings(file, lines[index - 1], line, index + 1, denylist, extra));
  }
  return findings;
}

// ---------------------------------------------------------------------------------------------------------------------
// The allowlist (K.5)
// ---------------------------------------------------------------------------------------------------------------------

function validRelativePath(value) {
  return typeof value === "string" && value.length > 0 && !/[\\*?[\]]/.test(value) && !value.startsWith("/") && !value.endsWith("/") &&
    !value.split("/").includes("..") && !value.split("/").includes("");
}

/**
 * Validates an allow document ({ version: 1, entries: [{ rule, paths, lines?, reason }] }) against the denylist and returns
 * [{ rule, paths, lines, reason, scope }]. `scope` is "history" for entries about commit or tag metadata, "tree" otherwise.
 * `lines` (optional; undefined when absent) narrows a waiver of a file to those line numbers of the tree. A secret-shape waiver
 * of a file must have it: a token-shaped constant is waived where it is, not in the whole file.
 */
export function parseAllow(document, { denylist }) {
  const fail = (message) => {
    throw new Error(`allow list: ${message}`);
  };
  if (document === null || typeof document !== "object" || Array.isArray(document)) fail("the document must be a JSON object");
  if (document.version !== 1) fail("version must be 1");
  if (!Array.isArray(document.entries)) fail("entries must be an array");
  const seen = new Set();
  return document.entries.map((entry, index) => {
    const label = `entry ${index + 1}`;
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) fail(`${label} must be an object`);
    const extra = Object.keys(entry).filter((key) => !["rule", "paths", "lines", "reason"].includes(key));
    if (extra.length > 0) fail(`${label} has unexpected key(s): ${extra.join(", ")}`);
    if (typeof entry.reason !== "string" || entry.reason.trim() === "") fail(`${label} needs a reason`);
    if (typeof entry.rule !== "string") fail(`${label} needs a rule`);
    const isDigest = entry.rule.startsWith("digest:");
    if (isDigest) {
      if (!denylist.ids.has(entry.rule.slice("digest:".length))) fail(`${label} names a digest id that is not in the denylist`);
    } else if (!HARD_RULE_IDS.includes(entry.rule)) {
      fail(`${label} names an unknown or report-only rule (${entry.rule})`);
    }
    if (!Array.isArray(entry.paths) || entry.paths.length === 0) fail(`${label} needs a non-empty paths array`);
    const historyPaths = entry.paths.filter(isHistoryPath);
    if (historyPaths.length > 0 && historyPaths.length !== entry.paths.length) fail(`${label} mixes commit or tag metadata and file paths: split it`);
    for (const p of entry.paths) {
      if (historyPaths.length > 0) {
        if (!HISTORY_PATHS.includes(p)) fail(`${label} has an unknown commit or tag path (allowed: ${HISTORY_PATHS.join(", ")})`);
      } else if (!validRelativePath(p)) {
        fail(`${label} has a path that is not a plain repository-relative file path`);
      } else if (isDigest && NO_DIGEST_ALLOW_UNDER.some((prefix) => p.startsWith(prefix))) {
        fail(`${label} waives a digest rule under ${NO_DIGEST_ALLOW_UNDER.find((prefix) => p.startsWith(prefix))}, which is never allowed`);
      }
      if (seen.has(`${entry.rule}\0${p}`)) fail(`${label} repeats a rule and path that another entry already waives`);
      seen.add(`${entry.rule}\0${p}`);
    }
    if (entry.lines !== undefined) {
      if (historyPaths.length > 0) fail(`${label} has lines, which a commit or tag metadata path does not have`);
      if (!Array.isArray(entry.lines) || entry.lines.length === 0 || !entry.lines.every((line) => Number.isInteger(line) && line > 0)) {
        fail(`${label} has lines that are not a non-empty array of positive integers`);
      }
      if (new Set(entry.lines).size !== entry.lines.length) fail(`${label} names a line twice`);
    } else if (entry.rule === "secret-shape" && historyPaths.length === 0) {
      fail(`${label} waives secret-shape for a file and names the lines it waives: add lines: [n, ...]`);
    }
    return {
      rule: entry.rule,
      paths: [...entry.paths],
      lines: entry.lines === undefined ? undefined : [...entry.lines],
      reason: entry.reason,
      scope: historyPaths.length > 0 ? "history" : "tree",
    };
  });
}

export function loadAllow(file, { denylist }) {
  let document;
  try {
    document = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (error) {
    throw new Error(`allow list: cannot read ${file}: ${error.message}`);
  }
  return parseAllow(document, { denylist });
}

/**
 * Sets `status` on every finding ("fail", "allowed" or "soft") and returns, for each entry, how many findings it waived and how many on each of its
 * lines. A digest hit that sits inside the span of a waived digest hit on the same line is waived with it (an allowed handle contains the owner's
 * first name; allowing the handle must not allow the name elsewhere on the line). With `honorLines` an entry that has lines waives only the findings
 * on those lines: that is the tree, whose line numbers are the file's own. The history cannot honor them, since a line was somewhere else in an
 * earlier commit, so there an entry waives its rule in its paths whatever the line.
 */
function applyAllow(findings, entries, { honorLines }) {
  const usage = entries.map((entry) => ({ count: 0, lines: new Map((entry.lines ?? []).map((line) => [line, 0])) }));
  const lookup = new Map();
  entries.forEach((entry, index) => entry.paths.forEach((p) => lookup.set(`${entry.rule}\0${p}`, index)));
  const groups = new Map();
  for (const finding of findings) {
    if (finding.kind === "soft") {
      finding.status = "soft";
      continue;
    }
    const index = lookup.get(`${finding.key}\0${finding.path}`);
    const lines = index === undefined ? undefined : entries[index].lines;
    if (index === undefined || (honorLines && lines !== undefined && !lines.includes(finding.line))) {
      finding.status = "fail";
    } else {
      finding.status = "allowed";
      usage[index].count += 1;
      if (usage[index].lines.has(finding.line)) usage[index].lines.set(finding.line, usage[index].lines.get(finding.line) + 1);
    }
    if (finding.rule === "digest") {
      const group = `${finding.commit ?? finding.tag ?? ""}\0${finding.side ?? ""}\0${finding.path}\0${finding.line}`;
      if (!groups.has(group)) groups.set(group, []);
      groups.get(group).push(finding);
    }
  }
  for (const group of groups.values()) {
    const waived = group.filter((finding) => finding.status === "allowed");
    for (const finding of group) {
      if (finding.status !== "fail") continue;
      const parent = waived.find((other) => other.start <= finding.start && finding.end <= other.end);
      if (parent) finding.status = "allowed";
    }
  }
  return usage;
}

/** The entries of `scope` that waived nothing, and those that waived something but not on every line that they name (`unusedLines`; only a file has lines). */
function staleEntries(entries, usage, scope) {
  const stale = [];
  entries.forEach((entry, index) => {
    if (entry.scope !== scope) return;
    if (usage[index].count === 0) {
      stale.push({ entry, index });
      return;
    }
    const unusedLines = [...usage[index].lines].filter(([, count]) => count === 0).map(([line]) => line);
    if (unusedLines.length > 0) stale.push({ entry, index, unusedLines });
  });
  return stale;
}

// ---------------------------------------------------------------------------------------------------------------------
// Tree mode
// ---------------------------------------------------------------------------------------------------------------------

export function scanTree({ root = DEFAULT_ROOT, denylist, allow = [], list = listFiles } = {}) {
  const files = list(root);
  const findings = [];
  let scanned = 0;
  let binary = 0;
  let missing = 0;
  for (const file of files) {
    findings.push(...pathFindings(file, denylist));
    let buffer;
    try {
      buffer = fs.readFileSync(path.join(root, ...file.split("/")));
    } catch (error) {
      if (error.code === "ENOENT" || error.code === "EISDIR") {
        missing += 1;
        continue;
      }
      throw error;
    }
    const text = decodeText(buffer);
    if (text === null) {
      binary += 1;
      findings.push(...stringFindings(file, extractStrings(buffer), denylist));
      continue;
    }
    scanned += 1;
    findings.push(...textFindings(file, text, denylist));
  }
  const usage = applyAllow(findings, allow, { honorLines: true });
  return { mode: "tree", root, listed: files.length, scanned, binary, missing, findings, stale: staleEntries(allow, usage, "tree") };
}

// ---------------------------------------------------------------------------------------------------------------------
// History mode
// ---------------------------------------------------------------------------------------------------------------------

// Record start, fields, record end. A line that starts a diff line can never start with the record-start control character.
const LOG_FORMAT = "%x1e%H%x1f%an <%ae>%x1f%cn <%ce>%x1f%s%x1f%b%x1d";
const LOG_ARGS = [
  "--no-pager", "-c", "core.quotepath=false", "log", "--all", "-p", "--no-color", "--no-ext-diff", "--no-textconv", "--no-renames", "--full-index",
  "--diff-merges=first-parent", `--format=${LOG_FORMAT}`,
];
const HUNK_HEADER = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/;
// `--full-index` gives the ids of the two blobs of a file's change; a binary change shows no lines, so its strings are read from the blobs.
const INDEX_LINE = /^index ([0-9a-f]{40,64})\.\.([0-9a-f]{40,64})/;
const BINARY_LINE = /^Binary files .* differ$/;
const NO_BLOB = /^0+$/;

function runGit(root, args, onLine, label = "git log") {
  return new Promise((resolve, reject) => {
    const child = spawn("git", args, { cwd: root, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    let stderr = "";
    let carry = "";
    let failure = null;
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => {
      if (stderr.length < 4000) stderr += chunk;
    });
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      if (failure) return;
      try {
        carry += chunk;
        let from = 0;
        let at;
        while ((at = carry.indexOf("\n", from)) !== -1) {
          onLine(carry.slice(from, at));
          from = at + 1;
        }
        carry = carry.slice(from);
      } catch (error) {
        failure = error;
        child.kill();
      }
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (failure) return reject(failure);
      try {
        if (carry !== "") onLine(carry);
      } catch (error) {
        return reject(error);
      }
      return code === 0 ? resolve() : reject(new Error(`${label} failed (exit ${code}): ${stderr.trim()}`));
    });
  });
}

/** The lines of a git command's output (a trailing carriage return removed from each). */
async function gitLines(root, args, label) {
  const lines = [];
  await runGit(root, args, (line) => lines.push(line.endsWith("\r") ? line.slice(0, -1) : line), label);
  return lines;
}

/** The content of a blob. */
function readBlob(root, id) {
  return new Promise((resolve, reject) => {
    execFile("git", ["--no-pager", "cat-file", "blob", id], { cwd: root, encoding: "buffer", maxBuffer: 1024 * 1024 * 1024, windowsHide: true }, (error, stdout, stderr) => {
      if (error) reject(new Error(`git cat-file failed: ${String(stderr).trim() || error.message}`));
      else resolve(stdout);
    });
  });
}

// "diff --git a/P b/P" with --no-renames: both paths are the same, so P is recoverable even when it contains spaces.
function headerPath(line) {
  const rest = line.slice("diff --git ".length);
  const total = rest.length - 5;
  if (rest.startsWith("a/") && total > 0 && total % 2 === 0) {
    const candidate = rest.slice(2, 2 + total / 2);
    if (rest === `a/${candidate} b/${candidate}`) return candidate;
  }
  return null;
}

// A tag ref names a commit (a lightweight tag) or a tag object (an annotated tag). A tag object has a name, a tagger and a message of its own, which
// `git log` never shows and a push publishes. A tag may point at another tag object; a chain this long is not a real repository.
const TAG_REF_ARGS = ["--no-pager", "for-each-ref", "--format=%(objecttype)%09%(objectname)%09%(refname)", "refs/tags"];
const TAG_REF_PREFIX = "refs/tags/";
const MAX_TAG_CHAIN = 16;

/**
 * The fields of a tag object as `git cat-file tag` prints it: the headers (`object`, `type`, `tag`, `tagger`), an empty line, then the message.
 * @param {string[]} lines
 * @returns {{ object: string | null, type: string | null, name: string | null, tagger: string | null, message: string[] }}
 *   `tagger` is `Name <email>`, without the time stamp and zone that the header ends with
 */
export function parseTagObject(lines) {
  const blank = lines.indexOf("");
  const headers = blank === -1 ? lines : lines.slice(0, blank);
  const header = (name) => {
    const line = headers.find((candidate) => candidate.startsWith(`${name} `));
    return line === undefined ? null : line.slice(name.length + 1);
  };
  const tagger = header("tagger");
  return {
    object: header("object"),
    type: header("type"),
    name: header("tag"),
    tagger: tagger === null ? null : tagger.replace(/ \d+ [+-]\d{4}$/, ""),
    message: blank === -1 ? [] : lines.slice(blank + 1),
  };
}

/**
 * Scans the name of every tag ref and, for every annotated tag object (and every tag object that one of them points to), its own name, tagger and message.
 * @param {string} root
 * @param {(file: string, text: string, line: number, extra: object) => void} scanText records the findings of one line
 * @param {(file: string, previous: string, text: string, line: number, extra: object) => void} scanPair records the findings across the break before a line
 * @returns {Promise<number>} how many tag objects were scanned
 */
async function scanTagObjects(root, scanText, scanPair) {
  const refs = [];
  await runGit(
    root,
    TAG_REF_ARGS,
    (line) => {
      const [type, sha, ref] = line.split("\t");
      if (type && sha && ref?.startsWith(TAG_REF_PREFIX)) refs.push({ type, sha, name: ref.slice(TAG_REF_PREFIX.length) });
    },
    "git for-each-ref",
  );
  const scanned = new Set();
  for (const { type, sha, name } of refs) {
    scanText("tag:name", name, 1, { tag: sha });
    let current = type === "tag" ? sha : null;
    for (let depth = 0; current !== null && depth < MAX_TAG_CHAIN && !scanned.has(current); depth += 1) {
      scanned.add(current);
      const tag = parseTagObject(await gitLines(root, ["--no-pager", "cat-file", "tag", current], "git cat-file"));
      const extra = { tag: current };
      if (tag.name !== null && (depth > 0 || tag.name !== name)) scanText("tag:name", tag.name, 1, extra);
      if (tag.tagger !== null) scanText("tag:tagger", tag.tagger, 1, extra);
      tag.message.forEach((line, index) => {
        scanText("tag:message", line, index + 1, extra);
        if (index > 0) scanPair("tag:message", tag.message[index - 1], line, index + 1, extra);
      });
      current = tag.type === "tag" ? tag.object : null;
    }
  }
  return scanned.size;
}

export async function scanHistory({ root = DEFAULT_ROOT, denylist, allow = [] } = {}) {
  const findings = [];
  let commits = 0;
  let commit = null;
  let file = null;
  let inHunk = false;
  let oldLine = 0;
  let newLine = 0;
  let record = null;
  // The last line of each side of the hunk that has been read, so that a line is joined with the one before it on the same side. A pair of unchanged
  // lines is not scanned: it was scanned when it was added.
  let previous = { added: null, removed: null };
  // The blobs of the file whose header is being read, and the binary changes found so far (their strings are read once the log is complete).
  let blobs = null;
  const binaries = [];

  const scanText = (file_, text, line, extra) => {
    for (const hit of lineHits(text, { path: file_, denylist, generic: !isFixturePath(file_) })) findings.push(makeFinding(file_, line, hit, extra));
  };

  const scanPair = (file_, before, text, line, extra) => {
    findings.push(...pairFindings(file_, before, text, line, denylist, extra));
  };

  const finishRecord = () => {
    const body = record.slice(0, record.indexOf("\x1d"));
    record = null;
    const [sha, author, committer, subject, message = ""] = body.split("\x1f");
    commit = sha;
    commits += 1;
    file = null;
    inHunk = false;
    const extra = { commit: sha };
    scanText("commit:author", author, 1, extra);
    scanText("commit:committer", committer, 1, extra);
    scanText("commit:subject", subject, 1, extra);
    const lines = message.split("\n").map((text) => (text.endsWith("\r") ? text.slice(0, -1) : text));
    lines.forEach((text, index) => {
      scanText("commit:body", text, index + 1, extra);
      if (index > 0) scanPair("commit:body", lines[index - 1], text, index + 1, extra);
    });
  };

  // A line of a hunk on `side`, which is on line number `number` there: scanned when it changed, and joined with the line before it when either changed.
  const readLine = (side, text, number, changed) => {
    if (changed) scanText(file, text, number, { commit, side });
    const before = previous[side];
    if (before !== null && (before.changed || changed)) scanPair(file, before.text, text, number, { commit, side });
    previous[side] = { text, changed };
  };

  const onLine = (raw) => {
    if (record !== null) {
      record += `\n${raw}`;
      if (record.includes("\x1d")) finishRecord();
      return;
    }
    if (raw.startsWith("\x1e")) {
      record = raw.slice(1);
      if (record.includes("\x1d")) finishRecord();
      return;
    }
    const line = raw.endsWith("\r") ? raw.slice(0, -1) : raw;
    if (line.startsWith("diff --git ")) {
      file = headerPath(line) ?? "commit:path";
      inHunk = false;
      blobs = null;
      previous = { added: null, removed: null };
      if (file === "commit:path") scanText(file, line.slice("diff --git ".length), 1, { commit });
      else findings.push(...pathFindings(file, denylist, { commit }));
      return;
    }
    if (!inHunk) {
      const index = INDEX_LINE.exec(line);
      if (index) {
        blobs = { removed: index[1], added: index[2] };
        return;
      }
      if (blobs !== null && BINARY_LINE.test(line)) {
        binaries.push({ file, commit, blobs });
        return;
      }
      const header = HUNK_HEADER.exec(line);
      if (header) {
        oldLine = Number(header[1]);
        newLine = Number(header[2]);
        inHunk = true;
      }
      return;
    }
    const header = HUNK_HEADER.exec(line);
    if (header) {
      oldLine = Number(header[1]);
      newLine = Number(header[2]);
      previous = { added: null, removed: null };
    } else if (line.startsWith("+")) {
      readLine("added", line.slice(1), newLine, true);
      newLine += 1;
    } else if (line.startsWith("-")) {
      readLine("removed", line.slice(1), oldLine, true);
      oldLine += 1;
    } else if (line.startsWith(" ")) {
      readLine("added", line.slice(1), newLine, false);
      readLine("removed", line.slice(1), oldLine, false);
      oldLine += 1;
      newLine += 1;
    }
  };

  await runGit(root, LOG_ARGS, onLine);
  // A binary change shows no lines: the strings of the blob before and after it are compared, and a string that only one of them has is a line that
  // the change added or removed (numbered by its place among the strings of that blob).
  for (const { file: path_, commit: sha, blobs: ids } of binaries) {
    const strings = {};
    for (const side of ["removed", "added"]) strings[side] = NO_BLOB.test(ids[side]) ? [] : extractStrings(await readBlob(root, ids[side]));
    for (const [side, other] of [["added", "removed"], ["removed", "added"]]) {
      const kept = new Set(strings[other]);
      const own = strings[side].map((text, index) => ({ text, index })).filter(({ text }) => !kept.has(text));
      const generic = !isFixturePath(path_);
      for (const { text, index } of own) {
        for (const hit of lineHits(text, { path: path_, denylist, generic })) findings.push(makeFinding(path_, index + 1, hit, { commit: sha, side }));
      }
    }
  }
  const tags = await scanTagObjects(root, scanText, scanPair);
  const usage = applyAllow(findings, allow, { honorLines: false });
  return { mode: "history", root, commits, tags, findings, stale: staleEntries(allow, usage, "history") };
}

// ---------------------------------------------------------------------------------------------------------------------
// Output
// ---------------------------------------------------------------------------------------------------------------------

/** A function that returns a path with every hard or digest match replaced by "*": a path can itself be the leak. */
export function createMasker(denylist) {
  const cache = new Map();
  return (value) => {
    if (cache.has(value)) return cache.get(value);
    let masked = value;
    if (!value.startsWith("commit:") && !value.startsWith("tag:")) {
      const chars = value.split("");
      for (const hit of lineHits(value, { path: value, denylist, generic: true, isPath: true })) {
        if (hit.kind !== "hard") continue;
        for (let at = hit.start; at < hit.end && at < chars.length; at += 1) chars[at] = "*";
      }
      masked = chars.join("");
    }
    cache.set(value, masked);
    return masked;
  };
}

export function formatFinding(finding, mask) {
  let text = `${mask(finding.path)}:${finding.line}:${finding.start}-${finding.end} rule=${finding.rule}`;
  if (finding.id) text += ` id=${finding.id} category=${finding.category}`;
  if (finding.commit) text += ` commit=${finding.commit.slice(0, 10)}`;
  if (finding.tag) text += ` tag=${finding.tag.slice(0, 10)}`;
  if (finding.side) text += ` side=${finding.side}`;
  return text;
}

const byStatus = (result, status) => result.findings.filter((finding) => finding.status === status);

/** Lines for a normal run: every failing finding, every stale entry, then one summary line. */
export function formatRun(result, mask) {
  const lines = byStatus(result, "fail").map((finding) => formatFinding(finding, mask));
  for (const { entry, index, unusedLines } of result.stale) {
    const where = `entry ${index + 1} (rule=${entry.rule} paths=${entry.paths.map(mask).join(",")})`;
    lines.push(
      unusedLines === undefined
        ? `allow.json: ${where} waived nothing: remove it`
        : `allow.json: ${where} waived nothing at line(s) ${unusedLines.join(", ")}: remove ${unusedLines.length === 1 ? "it" : "them"}`,
    );
  }
  const failing = byStatus(result, "fail");
  const files = new Set(failing.map((finding) => finding.path)).size;
  const scope = result.mode === "tree" ? `${result.scanned} text files scanned, ${result.binary} binary scanned for strings` : `${result.commits} commits and ${result.tags} annotated tags scanned`;
  lines.push(
    `leak-guard ${result.mode}: ${failing.length} failing finding(s) in ${files} file(s), ${byStatus(result, "allowed").length} allowed, ` +
      `${result.stale.length} stale allow entr${result.stale.length === 1 ? "y" : "ies"} (${scope}); ` +
      `${byStatus(result, "soft").length} report-only finding(s)${result.stale.length + failing.length === 0 ? "" : "; FAILED"}`,
  );
  return lines;
}

const ruleLabel = (finding) => finding.rule;

/** Counts per rule, per rule and top-level directory, per digest category, and per file for the report-only rule. */
export function summarize(result) {
  const byRule = new Map();
  const byDir = new Map();
  const byCategory = new Map();
  const softByFile = new Map();
  for (const finding of result.findings) {
    const label = ruleLabel(finding);
    if (!byRule.has(label)) byRule.set(label, { kind: finding.kind, fail: 0, allowed: 0, soft: 0, files: new Set(), lines: new Set() });
    const row = byRule.get(label);
    row[finding.status] += 1;
    if (finding.status !== "allowed") {
      row.files.add(finding.path);
      row.lines.add(`${finding.commit ?? ""}\0${finding.path}\0${finding.line}`);
      const dir = topDirectory(finding.path);
      if (!byDir.has(dir)) byDir.set(dir, new Map());
      byDir.get(dir).set(label, (byDir.get(dir).get(label) ?? 0) + 1);
    }
    if (finding.category && finding.status === "fail") byCategory.set(finding.category, (byCategory.get(finding.category) ?? 0) + 1);
    if (finding.status === "soft") softByFile.set(finding.path, (softByFile.get(finding.path) ?? 0) + 1);
  }
  return { byRule, byDir, byCategory, softByFile };
}

/** Lines for --report: counts only, never a finding's text. */
export function formatReport(result, mask) {
  const { byRule, byDir, byCategory, softByFile } = summarize(result);
  const lines = [];
  const scope = result.mode === "tree"
    ? `${result.listed} files listed, ${result.scanned} scanned as text, ${result.binary} binary (strings scanned), ${result.missing} missing`
    : `${result.commits} commits, ${result.tags} annotated tags`;
  lines.push(`leak-guard report (${result.mode}): ${scope}`, "");
  lines.push(`${"rule".padEnd(26)}${"kind".padEnd(6)}${"findings".padStart(10)}${"allowed".padStart(9)}${"lines".padStart(7)}${"files".padStart(7)}`);
  for (const [label, row] of [...byRule].sort((a, b) => a[0].localeCompare(b[0]))) {
    const cells = [String(row.fail + row.soft).padStart(10), String(row.allowed).padStart(9), String(row.lines.size).padStart(7), String(row.files.size).padStart(7)];
    lines.push(`${label.padEnd(26)}${row.kind.padEnd(6)}${cells.join("")}`);
  }
  if (byRule.size === 0) lines.push("(no findings)");
  if (byCategory.size > 0) {
    lines.push("", `digest findings by category: ${[...byCategory].sort().map(([category, count]) => `${category}=${count}`).join(" ")}`);
  }
  lines.push("", "findings by top-level directory (allowed findings excluded):");
  for (const [dir, counts] of [...byDir].sort((a, b) => a[0].localeCompare(b[0]))) {
    lines.push(`  ${dir.padEnd(18)}${[...counts].sort().map(([label, count]) => `${label}=${count}`).join(" ")}`);
  }
  if (byDir.size === 0) lines.push("  (none)");
  if (softByFile.size > 0) {
    lines.push("", `report-only findings per file (${softByFile.size} files):`);
    for (const [file, count] of [...softByFile].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))) lines.push(`  ${String(count).padStart(6)}  ${mask(file)}`);
  }
  if (result.stale.length > 0) {
    lines.push("", `stale allow entries: ${result.stale.length} (entries ${result.stale.map(({ index }) => index + 1).join(", ")}); a normal run lists each one`);
  }
  return lines;
}

// ---------------------------------------------------------------------------------------------------------------------
// Command line
// ---------------------------------------------------------------------------------------------------------------------

const USAGE = [
  "usage: node tools/leak-guard/scan.mjs [--tree] [--history] [--report] [--root <dir>] [--denylist <file>] [--allow <file>]",
  "",
  "  --tree       scan every tracked file (a plain directory is walked); the default",
  "  --history    scan every added and removed line of every commit, plus commit messages, authors and committers, and the name, tagger and message of every tag",
  "  --report     print counts per rule, directory and category instead of findings; always exits 0",
  "  --root       directory to scan (default: the repository this script belongs to)",
  "  --denylist   digest denylist (default: tools/leak-guard/denylist.json); an empty one is an error unless SDLC_LEAK_ALLOW_EMPTY=1",
  "  --allow      reviewed exceptions (default: tools/leak-guard/allow.json)",
  "",
  "A finding prints as path:line:col-col rule=<id>; line 0 is the path itself. The matched text is never printed.",
];

function parseArguments(argv) {
  const options = { tree: false, history: false, report: false, root: DEFAULT_ROOT, denylist: DEFAULT_DENYLIST, allow: DEFAULT_ALLOW, help: false };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === "--tree" || flag === "--history" || flag === "--report") options[flag.slice(2)] = true;
    else if (flag === "--help" || flag === "-h") options.help = true;
    else if (flag === "--root" || flag === "--denylist" || flag === "--allow") {
      const value = argv[index + 1];
      if (value === undefined || value.startsWith("--")) throw new Error(`${flag} needs a value`);
      options[flag.slice(2)] = path.resolve(value);
      index += 1;
    } else throw new Error(`unknown argument ${flag}`);
  }
  if (!options.tree && !options.history) options.tree = true;
  return options;
}

export async function main(argv, { stdout = process.stdout, stderr = process.stderr } = {}) {
  let options;
  let denylist;
  let allow;
  try {
    options = parseArguments(argv);
    if (options.help) {
      stdout.write(`${USAGE.join("\n")}\n`);
      return 0;
    }
    if (!fs.statSync(options.root, { throwIfNoEntry: false })?.isDirectory()) throw new Error(`--root is not a directory`);
    denylist = loadDenylist(options.denylist);
    allow = loadAllow(options.allow, { denylist });
  } catch (error) {
    stderr.write(`leak-guard: ${error.message}\n${USAGE[0]}\n`);
    return 2;
  }
  const mask = createMasker(denylist);
  let failed = false;
  const results = [];
  try {
    if (options.tree) results.push(scanTree({ root: options.root, denylist, allow }));
    if (options.history) results.push(await scanHistory({ root: options.root, denylist, allow }));
  } catch (error) {
    stderr.write(`leak-guard: ${error.message}\n`);
    return 2;
  }
  for (const result of results) {
    const lines = options.report ? formatReport(result, mask) : formatRun(result, mask);
    stdout.write(`${lines.join("\n")}\n`);
    if (byStatus(result, "fail").length > 0 || result.stale.length > 0) failed = true;
  }
  if (!options.report && failed) {
    stdout.write("Remove the text, or add a reviewed entry to tools/leak-guard/allow.json (a digest rule is never waived under src/, bin/, schemas/, prompts/, examples/ or tests/).\n");
  }
  return options.report || !failed ? 0 : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  process.exitCode = await main(process.argv.slice(2));
}
