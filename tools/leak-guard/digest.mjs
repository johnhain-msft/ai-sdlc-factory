// Digest denylist primitives, shared by the generator (make-digests.mjs) and the scanner (scan.mjs) so that a term and the
// text it appears in are always normalized by the same code.
//
//   tokens(text) = NFKC(text).toLowerCase().match(/[\p{L}\p{N}]+/gu)
//   a window     = 1..maxWindow consecutive tokens of ONE line, joined without separators
//   digest       = sha256(prefix + joined), hex
//
// A line is searched for a term in the spellings that code really has, all of which join to the same letters:
//
//   whole tokens   FooBar, foo_bar, FOO-BAR, foo.bar, foo bar        the windows above
//   pieces         fooBarSyncState, FooBar2, HTTPFooBar, name2024x   a token is also cut where a lower-case letter meets an upper-case one, where a
//                                                                    run of capitals ends and a word begins, and between letters and digits;
//                                                                    windows of up to MAX_WINDOW_LIMIT pieces are tried
//   inside a token xfoobar, foobar2s, afoobarb                       every part, MIN_JOINED_LENGTH characters or longer, of a token of up to
//                                                                    GLUE_MAX_TOKEN characters
//   at the ends    xfoo-bar, foo-bars, afoo.barb                     of a window of several tokens with no white space between them: up to
//                                                                    GLUE_MAX_EDGE characters are cut from the start of its first token and from
//                                                                    the end of its last, both for a window of GLUE_BOTH_MAX_TOKENS tokens or
//                                                                    fewer and one of them for a longer window
//
// A hexadecimal token of 24 characters or more (a commit or a content hash) is neither cut nor searched inside: no person writes a name there.
//
// The denylist file stores digests only (plus an opaque id and a coarse category). It never stores a term, and nothing in
// this module returns or prints the text that produced a hit: a hit is a position, an id and a category.
import crypto from "node:crypto";
import fs from "node:fs";

export const FORMAT_VERSION = 1;
export const DEFAULT_PREFIX = "sdlc-leak-v1:";
export const DEFAULT_MAX_WINDOW = 8;
export const MAX_WINDOW_LIMIT = 16;
/** The shortest term (letters and digits, joined) that the generator accepts: a shorter one is ordinary text. The glue search starts at this length. */
export const MIN_JOINED_LENGTH = 6;
export const GLUE_MAX_TOKEN = 64;
export const GLUE_MAX_EDGE = 3;
export const GLUE_BOTH_MAX_TOKENS = 4;
export const CATEGORIES = Object.freeze(["handle", "org", "repo", "app", "host", "person", "other"]);

const GLUE_MAX_JOINED = 96;
const LONG_HEX_TOKEN = 24;
const HEX_DIGITS = /^[0-9a-f]+$/;
const TOKEN = /[\p{L}\p{N}]+/gu;
const WHITESPACE = /\s/;
const SPLITTABLE = /[\p{Lu}\p{Lt}]|\p{L}\p{N}|\p{N}\p{L}/u;
const DIGIT = /^\p{N}$/u;
const UPPER = /^[\p{Lu}\p{Lt}]$/u;
const LOWER = /^\p{Ll}$/u;
const DIGEST_KEY = /^[0-9a-f]{64}$/;
const ID_SHAPE = /^d\d{2,}$/;

/** NFKC, then lower case: the one normalization applied to terms and to scanned text. */
export function normalize(text) {
  return String(text).normalize("NFKC").toLowerCase();
}

/**
 * The tokens of a text with their positions in `normalize(text)`. `exact` says whether those positions are also valid
 * positions in the original text (normalization kept every length): when it is false the caller must not trust columns.
 */
export function tokenSpans(text) {
  const normalized = normalize(text);
  const spans = [];
  for (const match of normalized.matchAll(TOKEN)) {
    spans.push({ token: match[0], start: match.index, end: match.index + match[0].length });
  }
  return { spans, exact: normalized.length === String(text).length };
}

export function tokens(text) {
  return tokenSpans(text).spans.map((span) => span.token);
}

export function sha256Hex(text) {
  return crypto.hash("sha256", text, "hex");
}

export function digestOfJoined(joined, prefix = DEFAULT_PREFIX) {
  return sha256Hex(prefix + joined);
}

/** The digest of a term: the same value a window of the same tokens has in the scanner. */
export function digestOfTerm(term, { prefix = DEFAULT_PREFIX } = {}) {
  return digestOfJoined(tokens(term).join(""), prefix);
}

/**
 * Where a split at `cut` falls among `items` (tokens or pieces, in order, with start and end): { a, b }, `a` the index of the last item that starts before
 * the cut and `b` the first that ends after it. A window of items spans the cut only if it starts at an index of `a` or less and ends at one of `b` or more.
 */
function aroundCut(items, cut) {
  let a = -1;
  while (a + 1 < items.length && items[a + 1].start < cut) a += 1;
  const b = a >= 0 && items[a].end > cut ? a : a + 1;
  return { a, b, none: a < 0 || b >= items.length };
}

/**
 * Every window of 1..maxWindow consecutive tokens, as { first, count, joined, start, end } (positions in the normalized text). With `around` (see aroundCut)
 * only the windows that can span the cut are visited.
 */
export function* windows(spans, maxWindow = DEFAULT_MAX_WINDOW, around = null) {
  const firstTo = around === null ? spans.length - 1 : around.a;
  for (let first = around === null ? 0 : Math.max(0, around.b - maxWindow + 1); first <= firstTo; first += 1) {
    let joined = "";
    const stop = Math.min(spans.length, first + maxWindow);
    for (let last = first; last < stop; last += 1) {
      joined += spans[last].token;
      if (around === null || last >= around.b) yield { first, count: last - first + 1, joined, start: spans[first].start, end: spans[last].end };
    }
  }
}

const kindOf = (character) => (DIGIT.test(character) ? "d" : UPPER.test(character) ? "U" : LOWER.test(character) ? "l" : "o");

/** A copy of `text` that is not a cut of a longer text: such a cut keeps the longer text alive in the engine for as long as it lives, a cache key included. */
const own = (text) => (text.length < 13 ? text : ` ${text}`.slice(1));

/** Where a new piece starts inside `original` (a token, with its case), or null for a token that is one piece. */
function pieceCuts(original) {
  if (!SPLITTABLE.test(original)) return null;
  const points = [];
  let offset = 0;
  for (const character of original) {
    points.push([offset, kindOf(character)]);
    offset += character.length;
  }
  const cuts = [];
  for (let index = 1; index < points.length; index += 1) {
    const [at, kind] = points[index];
    const before = points[index - 1][1];
    if ((before === "d") !== (kind === "d")) cuts.push(at);
    else if (before === "l" && kind === "U") cuts.push(at);
    else if (before === "U" && kind === "U" && index + 1 < points.length && points[index + 1][1] === "l") cuts.push(at);
  }
  return cuts.length > 0 ? cuts : null;
}

/**
 * The tokens of a line, as tokenSpans finds them, each with what the glue search needs: `loose` (white space lies between it and the token before),
 * `hex` (a long hexadecimal token) and `cuts` (where its pieces start). Positions are in the normalized text; `exact` says they are also valid in the line.
 */
function analyze(line) {
  const source = String(line);
  const folded = source.normalize("NFKC");
  const normalized = folded.toLowerCase();
  const exact = normalized.length === source.length && folded.length === source.length;
  const found = [];
  let previousEnd = 0;
  for (const match of normalized.matchAll(TOKEN)) {
    const token = own(match[0]);
    const start = match.index;
    const end = start + token.length;
    const hex = token.length >= LONG_HEX_TOKEN && HEX_DIGITS.test(token);
    found.push({ token, start, end, hex, loose: start > previousEnd && WHITESPACE.test(normalized.slice(previousEnd, start)), cuts: exact && !hex ? pieceCuts(folded.slice(start, end)) : null });
    previousEnd = end;
  }
  return { tokens: found, exact, length: source.length };
}

/** The pieces of every token, in order: { text, start, end, owner (the index of its token), opens (the first of its token), closes (the last of it) }. */
function piecesOf(found) {
  const pieces = [];
  found.forEach((token, owner) => {
    const bounds = [0, ...(token.cuts ?? []), token.end - token.start];
    for (let index = 0; index + 1 < bounds.length; index += 1) {
      pieces.push({
        text: token.token.slice(bounds[index], bounds[index + 1]),
        start: token.start + bounds[index],
        end: token.start + bounds[index + 1],
        owner,
        opens: index === 0,
        closes: index + 2 === bounds.length,
      });
    }
  });
  return pieces;
}

// What a denylist answers is remembered, so that the many windows, tokens and lines of a tree that repeat are hashed once. One set of caches per denylist, each
// emptied when it holds too much. A text that is cut from a long one keeps the long one alive in the engine, so the tokens and the cached lines are copies.
const CACHE_LIMIT = 400_000;
const LINE_CACHE_CHARS = 32 * 1024 * 1024;
const LINE_CACHE_MAX_LINE = 16 * 1024;
const CACHES = new WeakMap();
function cachesOf(denylist) {
  let caches = CACHES.get(denylist);
  if (caches === undefined) {
    caches = { joined: new Map(), inner: new Map(), lines: new Map(), lineChars: 0 };
    CACHES.set(denylist, caches);
  }
  return caches;
}

/** The parts of one token that are a term: [{ from, to, entry }]. A token is searched once, whatever line it is in. */
function innerHitsOf(denylist, caches, token) {
  let found = caches.inner.get(token);
  if (found === undefined) {
    found = [];
    const size = token.length;
    for (let from = 0; from + MIN_JOINED_LENGTH <= size; from += 1) {
      for (let to = from + MIN_JOINED_LENGTH; to <= size; to += 1) {
        if (from === 0 && to === size) continue;
        const entry = denylist.byDigest.get(digestOfJoined(token.slice(from, to), denylist.prefix));
        if (entry !== undefined) found.push({ from, to, entry });
      }
    }
    if (caches.inner.size >= CACHE_LIMIT) caches.inner.clear();
    caches.inner.set(token, found);
  }
  return found;
}

/**
 * Digest hits in one line: [{ id, category, start, end }] with 0-based, end-exclusive positions in `line`, in the order of their positions. When the
 * normalization changed the line's length the exact columns are unknowable and the hit covers the whole line.
 *
 * `split` is a position in `line`: only a hit that spans it is returned. The scanner joins the end of a line to the start of the next one and asks for
 * the hits that cross the join, so that a term that a line break cut in two is found, and one that either line holds on its own is not found twice.
 */
export function digestHits(line, denylist, { split } = {}) {
  const text = String(line);
  const caches = cachesOf(denylist);
  if (split === undefined) {
    const known = caches.lines.get(text);
    if (known !== undefined) return known.map((hit) => ({ ...hit }));
  }
  const hits = searchLine(text, denylist, caches, split);
  if (split === undefined && text.length <= LINE_CACHE_MAX_LINE) {
    if (caches.lineChars + text.length > LINE_CACHE_CHARS) {
      caches.lines.clear();
      caches.lineChars = 0;
    }
    caches.lines.set(own(text), hits.map((hit) => ({ ...hit })));
    caches.lineChars += text.length;
  }
  return hits;
}

function searchLine(text, denylist, caches, split) {
  const { tokens: found, exact, length } = analyze(text);
  if (found.length === 0) return [];
  const cut = split === undefined ? -1 : normalize(text.slice(0, split)).length;
  const around = cut < 0 ? null : aroundCut(found, cut);
  if (around !== null && around.none) return [];
  const hits = [];
  const seen = new Set();

  const record = (entry, start, end) => {
    if (cut >= 0 && !(start < cut && cut < end)) return;
    const from = exact ? start : 0;
    const to = exact ? end : length;
    const key = `${entry.id}:${from}:${to}`;
    if (seen.has(key)) return;
    seen.add(key);
    hits.push({ id: entry.id, category: entry.category, start: from, end: to });
  };

  const probe = (joined, start, end) => {
    if (cut >= 0) {
      // across a line break the windows are rarely the same twice: they are not remembered
      if (start < cut && cut < end) {
        const entry = denylist.byDigest.get(digestOfJoined(joined, denylist.prefix));
        if (entry !== undefined) record(entry, start, end);
      }
      return;
    }
    let entry = caches.joined.get(joined);
    if (entry === undefined) {
      entry = denylist.byDigest.get(digestOfJoined(joined, denylist.prefix)) ?? null;
      if (caches.joined.size >= CACHE_LIMIT) caches.joined.clear();
      caches.joined.set(joined, entry);
    }
    if (entry !== null) record(entry, start, end);
  };

  // The windows of whole tokens.
  for (const window of windows(found, denylist.maxWindow, around)) probe(window.joined, window.start, window.end);

  // The windows of pieces that a window of whole tokens is not: camelCase and digits at an end. A window inside one token is searched part by part below.
  if (exact && found.some((token) => token.cuts !== null)) {
    const pieces = piecesOf(found);
    const near = cut < 0 ? null : aroundCut(pieces, cut);
    if (near === null || !near.none) {
      const firstTo = near === null ? pieces.length - 1 : near.a;
      for (let first = near === null ? 0 : Math.max(0, near.b - MAX_WINDOW_LIMIT + 1); first <= firstTo; first += 1) {
        const head = pieces[first];
        let joined = "";
        const stop = Math.min(pieces.length, first + MAX_WINDOW_LIMIT);
        for (let last = first; last < stop; last += 1) {
          const tail = pieces[last];
          joined += tail.text;
          if (joined.length > GLUE_MAX_JOINED) break;
          if ((near !== null && last < near.b) || (head.opens && tail.closes)) continue;
          if (head.owner === tail.owner && found[head.owner].token.length <= GLUE_MAX_TOKEN) continue;
          if (joined.length >= MIN_JOINED_LENGTH) probe(joined, head.start, tail.end);
        }
      }
    }
  }

  // A term inside one token: any part of it.
  for (const token of found) {
    const size = token.token.length;
    if (size <= MIN_JOINED_LENGTH || size > GLUE_MAX_TOKEN || token.hex) continue;
    if (cut >= 0 && !(token.start < cut && cut < token.end)) continue;
    for (const part of innerHitsOf(denylist, caches, token.token)) record(part.entry, token.start + part.from, token.start + part.to);
  }

  // A term whose words keep their separators, with letters glued to its first or last word: those letters are cut off. Across a line break this is not
  // searched: a term that is cut, glued and spelled with separators is not worth what it would cost on every pair of lines.
  const firstTo = around === null ? found.length - 2 : -1;
  for (let first = 0; first <= firstTo; first += 1) {
    const head = found[first];
    if (head.hex) continue;
    const headCuts = Math.min(GLUE_MAX_EDGE, head.token.length - 1);
    const stop = Math.min(found.length, first + denylist.maxWindow);
    let middle = "";
    for (let last = first + 1; last < stop; last += 1) {
      const tail = found[last];
      if (tail.loose) break;
      if (!tail.hex) {
        const tailCuts = Math.min(GLUE_MAX_EDGE, tail.token.length - 1);
        const both = last - first + 1 <= GLUE_BOTH_MAX_TOKENS;
        for (let atHead = 0; atHead <= headCuts; atHead += 1) {
          for (let atTail = 0; atTail <= tailCuts; atTail += 1) {
            if ((atHead === 0 && atTail === 0) || (!both && atHead > 0 && atTail > 0)) continue;
            const total = head.token.length - atHead + middle.length + tail.token.length - atTail;
            if (total < MIN_JOINED_LENGTH || total > GLUE_MAX_JOINED) continue;
            probe(head.token.slice(atHead) + middle + tail.token.slice(0, tail.token.length - atTail), head.start + atHead, tail.end - atTail);
          }
        }
      }
      middle += tail.token;
    }
  }

  return hits.sort((a, b) => a.start - b.start || a.end - b.end || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/**
 * Validates a denylist document and returns its runtime form { prefix, maxWindow, byDigest, ids }. Throws on anything that is
 * not exactly the documented shape, so a hand-edited or corrupted file cannot quietly weaken the guard.
 */
export function parseDenylist(document, { allowEmpty = false } = {}) {
  const fail = (message) => {
    throw new Error(`denylist: ${message}`);
  };
  if (document === null || typeof document !== "object" || Array.isArray(document)) fail("the document must be a JSON object");
  const unknown = Object.keys(document).filter((key) => !["version", "prefix", "maxWindow", "digests"].includes(key));
  if (unknown.length > 0) fail(`unexpected top-level key(s): ${unknown.join(", ")}`);
  if (document.version !== FORMAT_VERSION) fail(`version must be ${FORMAT_VERSION}`);
  if (typeof document.prefix !== "string" || document.prefix.length === 0) fail("prefix must be a non-empty string");
  if (!Number.isInteger(document.maxWindow) || document.maxWindow < 1 || document.maxWindow > MAX_WINDOW_LIMIT) {
    fail(`maxWindow must be an integer from 1 to ${MAX_WINDOW_LIMIT}`);
  }
  if (document.digests === null || typeof document.digests !== "object" || Array.isArray(document.digests)) {
    fail("digests must be an object keyed by SHA-256 hex digest");
  }
  const byDigest = new Map();
  const ids = new Set();
  for (const [digest, entry] of Object.entries(document.digests)) {
    if (!DIGEST_KEY.test(digest)) fail("every digests key must be 64 lower-case hex characters");
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) fail(`entry ${digest.slice(0, 8)}… must be an object`);
    const extra = Object.keys(entry).filter((key) => key !== "id" && key !== "category");
    if (extra.length > 0) fail(`entry ${digest.slice(0, 8)}… has unexpected key(s): ${extra.join(", ")}`);
    if (typeof entry.id !== "string" || !ID_SHAPE.test(entry.id)) fail(`entry ${digest.slice(0, 8)}… needs an id like d01`);
    if (!CATEGORIES.includes(entry.category)) fail(`entry ${entry.id} has an unknown category (allowed: ${CATEGORIES.join(", ")})`);
    if (ids.has(entry.id)) fail(`id ${entry.id} is used twice`);
    ids.add(entry.id);
    byDigest.set(digest, { id: entry.id, category: entry.category });
  }
  if (byDigest.size === 0 && !allowEmpty) {
    fail("the denylist is empty, which protects nothing (set SDLC_LEAK_ALLOW_EMPTY=1 only in a development job)");
  }
  return { prefix: document.prefix, maxWindow: document.maxWindow, byDigest, ids };
}

/** Reads and validates a denylist file. An empty list is an error unless `allowEmpty` or SDLC_LEAK_ALLOW_EMPTY=1. */
export function loadDenylist(file, { allowEmpty = process.env.SDLC_LEAK_ALLOW_EMPTY === "1" } = {}) {
  let document;
  try {
    document = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (error) {
    throw new Error(`denylist: cannot read ${file}: ${error.message}`);
  }
  return parseDenylist(document, { allowEmpty });
}
