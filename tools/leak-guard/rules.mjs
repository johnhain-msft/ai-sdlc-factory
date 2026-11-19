// Generic leak rules (design K.2): patterns that need no knowledge of the repository owner. Each rule reports positions only
// (0-based, end exclusive); nothing here returns the text that matched, so a caller cannot print it by accident.
//
// A hard rule fails the guard. A soft rule is reported by --report and never fails. A rule runs on the lines of a file and
// on the file's path; `onPaths: false` marks the rules that only make sense for content.

const WIN_HOME_EXEMPT = new Set(["runneradmin", "public", "default", "username", "%username%", "<user>", "user"]);
const POSIX_HOME_EXEMPT = new Set(["runner", "runneradmin", "vsts", "ubuntu", "user", "you", "node", "example", "<user>"]);
// "$USER", "%USERPROFILE%", "<user>": a variable or template slot, not a person.
const PLACEHOLDER_NAME = /^[$%<{]/;

// A user directory on Windows: the drive, "Users", then a name, where each separator is one backslash, an escaped pair
// (JSON), a doubly escaped quad, or a slash.
const WIN_HOME = /[A-Za-z]:(?:\\{1,4}|\/)Users(?:\\{1,4}|\/)([^\\\/\s"'`):;,|*?[\]{}]+)/gi;
// A user directory on macOS or Linux. Case-sensitive on purpose: a URL path such as an API "users" segment is not a home.
const POSIX_HOME = /\/(?:Users|home)\/([A-Za-z0-9._-]+|<[^<>\s]*>)(?=\/|[\s"'`),:;\]}]|$)/g;
const DRIVE_BEFORE = /(?:^|\W)[A-Za-z]:$/;
const MOUNT_BEFORE = /(?:^|[^\w.~-])(?:\/mnt)?\/[A-Za-z]$/;

const MICROSOFT_EMAIL = /[\w.+-]{1,64}@microsoft\.com\b/gi;
const EMAIL = /[\w.+-]{1,64}@((?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)+[A-Za-z]{2,24})\b/g;
// "scheme://user:secret@host" and "scheme://user@host" carry credentials, not an address.
const URL_USERINFO = /\b[A-Za-z][A-Za-z0-9+.-]*:\/\/[^\s/@]*@/g;
const EMAIL_EXACT = new Set(["users.noreply.github.com", "github.com", "microsoft.com"]);
const EMAIL_OR_SUBDOMAIN = ["example.com", "example.org", "example.invalid", "localhost"];
// "a/b/c.d@e.yaml" and "logo@2x.png" are file names: no mailbox ends in a file extension that is not a top-level domain.
const FILE_EXTENSIONS = new Set(
  `yaml yml json jsonc png jpg jpeg gif svg webp ico bmp mjs cjs js jsx ts tsx css scss html htm txt csv tsv xml toml ini lock log map
   ps1 bat cmd exe dll tgz gz tar pdf doc docx ppt pptx xls xlsx mp3 mp4 woff woff2 ttf tmp bak`.split(/\s+/),
);

const INTERNAL_HOST =
  /(?<![A-Za-z0-9-])(?:visualstudio\.com|pkgs\.dev\.azure\.com|dev\.azure\.com|microsoft\.io|sharepoint\.com|corp\.microsoft\.com|msft\.net)(?![A-Za-z0-9])|(?<![A-Za-z0-9])ms[-]feed(?![A-Za-z0-9])/gi;

// A Copilot session directory named by a UUID, or a Copilot home directory. "$HOME/.copilot/..." is what compiled workflows
// write for every run, so a directory that follows a home variable or "~" is not a person's path.
const SESSION_STATE =
  /session-state[\\/][0-9a-f]{8}-[0-9a-f]{4}|(?<!(?:\$\{?(?:HOME|USERPROFILE)\}?|\$env:(?:HOME|USERPROFILE)|%USERPROFILE%|~)[\\/])\.copilot[\\/]/gi;

const COMMENT_MARKER = /\/\/|#|\*|<!--/;
const RUN_ID = /\b(?:runs?|run[ -]?id|workflow run)\b[^\n]{0,40}?\b(\d{9,})\b/gid;
const ACTIONS_RUN_URL = /\/actions\/runs\/(\d{6,})/g;

const ISSUE_OR_PR = /\b(?:issue|pull request|PR)\s*#\d{1,6}\b/gi;
const PLAN_FILE = /(?<![\w-])plan\.md\b/gi;
const GUID = /\b[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b/gi;

// [pattern, capture group holding the secret body (undefined when the value has no body)]
const SECRET_PATTERNS = [
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----/g, undefined],
  [/\bgh[pousr]_([A-Za-z0-9]{36,})/g, 1],
  [/\bgithub_pat_([A-Za-z0-9_]{50,})/g, 1],
  [/\bAKIA([0-9A-Z]{16})\b/g, 1],
  [/\bxox[baprs]-([A-Za-z0-9-]{8,})/g, 1],
  [/\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.([A-Za-z0-9_-]{8,})/g, 1],
];

const LOCK_REGISTRY_PREFIX = "https://registry.npmjs.org/";
const LOCK_RESOLVED = /"resolved"\s*:\s*"([^"]*)"/g;
const LOCK_LINK = /"link"\s*:\s*true\b/g;
const LOCK_FILE_SPEC = /"file:[^"]*"/g;

const SOFT_SPEC_REFERENCE = /SPEC-0\d|\bAC\d{1,3}\b|\bOQ\d{2}\b/g;

const span = (match) => [match.index, match.index + match[0].length];

function findWindowsHome(text) {
  const spans = [];
  for (const match of text.matchAll(WIN_HOME)) {
    const name = match[1];
    if (WIN_HOME_EXEMPT.has(name.toLowerCase()) || PLACEHOLDER_NAME.test(name)) continue;
    spans.push(span(match));
  }
  return spans;
}

// True when the slash at `index` starts a path, so that a home-like segment inside a URL, a relative path or a Windows drive
// path is not mistaken for a home directory ("/mnt/c" and "/c" drive mounts still count).
function startsPath(text, index) {
  if (index === 0) return true;
  const before = text.slice(0, index);
  if (DRIVE_BEFORE.test(before)) return false;
  if (!/[\w.~-]$/.test(before)) return true;
  return MOUNT_BEFORE.test(before);
}

function findPosixHome(text) {
  const spans = [];
  for (const match of text.matchAll(POSIX_HOME)) {
    if (POSIX_HOME_EXEMPT.has(match[1].toLowerCase()) || !startsPath(text, match.index)) continue;
    spans.push(span(match));
  }
  return spans;
}

function findMicrosoftEmail(text) {
  if (!text.includes("@")) return [];
  return [...text.matchAll(MICROSOFT_EMAIL)].map(span);
}

function isAllowedEmailDomain(domain) {
  const host = domain.toLowerCase();
  if (FILE_EXTENSIONS.has(host.slice(host.lastIndexOf(".") + 1))) return true;
  return EMAIL_EXACT.has(host) || EMAIL_OR_SUBDOMAIN.some((allowed) => host === allowed || host.endsWith(`.${allowed}`));
}

function findAnyEmail(text) {
  if (!text.includes("@")) return [];
  const scrubbed = text.replace(URL_USERINFO, (userinfo) => " ".repeat(userinfo.length));
  const spans = [];
  for (const match of scrubbed.matchAll(EMAIL)) {
    if (!isAllowedEmailDomain(match[1])) spans.push(span(match));
  }
  return spans;
}

function findInternalHost(text) {
  return [...text.matchAll(INTERNAL_HOST)].map(span);
}

function findSessionState(text) {
  return [...text.matchAll(SESSION_STATE)].map(span);
}

function findRunId(text) {
  const spans = [];
  const marker = COMMENT_MARKER.exec(text);
  if (marker) {
    for (const match of text.slice(marker.index).matchAll(RUN_ID)) {
      spans.push([marker.index + match.indices[1][0], marker.index + match.indices[1][1]]);
    }
  }
  for (const match of text.matchAll(ACTIONS_RUN_URL)) {
    spans.push([match.index + match[0].length - match[1].length, match.index + match[0].length]);
  }
  return spans;
}

function findIssueOrPr(text) {
  return [...text.matchAll(ISSUE_OR_PR)].map(span);
}

function findPlanFile(text) {
  return [...text.matchAll(PLAN_FILE)].map(span);
}

function findGuid(text) {
  return [...text.matchAll(GUID)].map(span);
}

// A value that says it is not a secret (fake, example, a run of zeros) or is one character repeated is a fixture.
function isPlaceholderSecret(value, body) {
  if (/fake|example|0000/i.test(value)) return true;
  return body !== undefined && body.length > 0 && /^(.)\1*$/s.test(body);
}

function findSecretShape(text) {
  const spans = [];
  for (const [pattern, bodyGroup] of SECRET_PATTERNS) {
    for (const match of text.matchAll(pattern)) {
      const body = bodyGroup === undefined ? undefined : match[bodyGroup];
      if (!isPlaceholderSecret(match[0], body)) spans.push(span(match));
    }
  }
  return spans;
}

function findLockRegistry(text, { path = "", isPath = false } = {}) {
  if (isPath || path.split("/").pop() !== "package-lock.json") return [];
  const spans = [];
  for (const match of text.matchAll(LOCK_RESOLVED)) {
    const value = match[1];
    if (!value.startsWith(LOCK_REGISTRY_PREFIX) && !value.startsWith("file:")) spans.push(span(match));
  }
  for (const match of text.matchAll(LOCK_LINK)) spans.push(span(match));
  for (const match of text.matchAll(LOCK_FILE_SPEC)) spans.push(span(match));
  return spans;
}

function findSpecReference(text) {
  return [...text.matchAll(SOFT_SPEC_REFERENCE)].map(span);
}

export const RULES = Object.freeze([
  { id: "home-path-win", kind: "hard", onPaths: true, find: findWindowsHome },
  { id: "home-path-posix", kind: "hard", onPaths: true, find: findPosixHome },
  { id: "microsoft-email", kind: "hard", onPaths: true, find: findMicrosoftEmail },
  { id: "email-any", kind: "hard", onPaths: true, find: findAnyEmail },
  { id: "internal-host", kind: "hard", onPaths: true, find: findInternalHost },
  { id: "session-state-path", kind: "hard", onPaths: true, find: findSessionState },
  { id: "run-id-in-comment", kind: "hard", onPaths: false, find: findRunId },
  { id: "issue-or-pr-number", kind: "hard", onPaths: true, find: findIssueOrPr },
  { id: "plan-md-reference", kind: "hard", onPaths: true, find: findPlanFile },
  { id: "guid", kind: "hard", onPaths: true, find: findGuid },
  { id: "secret-shape", kind: "hard", onPaths: true, find: findSecretShape },
  { id: "lock-registry", kind: "hard", onPaths: false, find: findLockRegistry },
  { id: "soft:spec-ac-reference", kind: "soft", onPaths: false, find: findSpecReference },
]);

export const HARD_RULE_IDS = Object.freeze(RULES.filter((rule) => rule.kind === "hard").map((rule) => rule.id));
export const SOFT_RULE_IDS = Object.freeze(RULES.filter((rule) => rule.kind === "soft").map((rule) => rule.id));

/**
 * Runs every generic rule over one line (or one path, with `isPath`). Returns [{ rule, kind, start, end }] with 0-based,
 * end-exclusive positions. `path` is the repository-relative path of the file the line belongs to.
 */
export function findRuleHits(text, { path = "", isPath = false } = {}) {
  const hits = [];
  for (const rule of RULES) {
    if (isPath && !rule.onPaths) continue;
    for (const [start, end] of rule.find(text, { path, isPath })) hits.push({ rule: rule.id, kind: rule.kind, start, end });
  }
  return hits;
}
