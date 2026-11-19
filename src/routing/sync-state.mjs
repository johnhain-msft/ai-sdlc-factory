// The durable per-upstream state, SDLC_SYNC_STATE_<SLUG> (SPEC-03 AC13), as data: its fields, the checks that a value must pass before a script
// relies on it or writes it, and the one transition that both the router and the poll-state script share (AC49, AC50).
//
// Nothing here reads or writes the variable: src/update-poll-state.mjs is the only file that does.

import { assertShape, isRealUtcTimestamp, RoutingDataError } from "./schema.mjs";

/** The 14 fields, in the order in which they are serialised, under their canonical names: the fourth is `downstreamMainSha`. */
export const SYNC_STATE_FIELDS = Object.freeze([
  "etag",
  "lastObservedHeadSha",
  "lastMergedUpstreamSha",
  "downstreamMainSha",
  "lastNoopHeadSha",
  "dismissedTargetSha",
  "failedTargetSha",
  "failedAttempts",
  "blockedTargetSha",
  "inFlightRunId",
  "inFlightTargetSha",
  "openPrTargetSha",
  "openPrNumber",
  "updatedAt",
]);

/**
 * The name that the fourth field had before the state dialect: releases before 0.1.0 wrote and read it, so a variable that one of them wrote, or that a rollback
 * returns to, still carries it, and their code rejects the canonical name. The engine reads either name and, by default, writes the one that it read. Removed,
 * with the dialects, in 1.0.0 (design F.3, L.2).
 */
export const LEGACY_FIELD = "portfolioMainSha";
export const CANONICAL_FIELD = "downstreamMainSha";

/** The two spellings of a state on the wire. */
export const DIALECTS = Object.freeze(["legacy", "downstream"]);
/** What the manifest's `state.dialect` may say: a dialect to write, or `preserve` (write the one that was read). */
export const DIALECT_SETTINGS = Object.freeze(["preserve", ...DIALECTS]);

/** The dialect that a state as it was read from the variable is in. */
export const dialectOf = (wire) => (Object.hasOwn(wire, LEGACY_FIELD) ? "legacy" : "downstream");

/** The dialect that a write uses: what the manifest's setting says, or, for `preserve`, the one that the state was read in. @throws {RoutingDataError} */
export function resolveWriteDialect(setting = "preserve", read) {
  if (!DIALECT_SETTINGS.includes(setting)) throw new RoutingDataError(`the state dialect setting ${JSON.stringify(setting)} is not one of ${DIALECT_SETTINGS.join(", ")}`);
  return setting === "preserve" ? read : setting;
}

/** The limit of one Actions variable [F67]: 48 KB. */
export const MAX_VARIABLE_BYTES = 48 * 1024;

/** The fields that carry no information about the upstream: a write that would change only these is not a change. */
export const BOOKKEEPING_FIELDS = Object.freeze(["updatedAt"]);

/** The state in the serialisation order under the canonical names, whichever name the fourth field has. */
const canonical = (state) => Object.fromEntries(SYNC_STATE_FIELDS.map((field) => [field, field === CANONICAL_FIELD && !Object.hasOwn(state, CANONICAL_FIELD) ? state[LEGACY_FIELD] : state[field]]));

/**
 * Checks an object against SyncState (either spelling of the fourth field, never both) and against the pairs of fields that the router's comparisons rely on: a
 * run id without the revision it was dispatched for, or a pull request number without its revision, is a state that no script wrote.
 * @returns {object} the same fields, in the serialisation order, under the canonical names
 * @throws {RoutingDataError}
 */
export function validateSyncState(value, label = "the sync state") {
  assertShape("SyncState", value, label);
  if (!isRealUtcTimestamp(value.updatedAt)) throw new RoutingDataError(`${label}.updatedAt '${value.updatedAt}' is not a real UTC timestamp`);
  if ((value.inFlightRunId === null) !== (value.inFlightTargetSha === null)) {
    throw new RoutingDataError(`${label} records inFlightRunId without inFlightTargetSha, or the reverse: the pair is written together`);
  }
  if ((value.openPrNumber === null) !== (value.openPrTargetSha === null)) {
    throw new RoutingDataError(`${label} records openPrNumber without openPrTargetSha, or the reverse: the pair is written together`);
  }
  return canonical(value);
}

/**
 * Parses the text of the variable.
 * @returns {{ state: object, dialect: "legacy" | "downstream" }} the canonical state, and the spelling that the text had
 * @throws {RoutingDataError}
 */
export function parseSyncState(text, label = "the sync state") {
  let value;
  try {
    value = JSON.parse(String(text));
  } catch (error) {
    throw new RoutingDataError(`${label} is not JSON: ${error.message}`);
  }
  return { state: validateSyncState(value, label), dialect: dialectOf(value) };
}

/**
 * The text to write: validated, in the serialisation order, with the fourth field spelled as `dialect` says, and within 48 KB. A value that is too large is
 * refused here, before any request. The default is the legacy spelling, for every 0.x release: whatever the engine writes unasked has to be readable by the
 * release before it (design L.2).
 * @param {object} state a state in either spelling
 * @param {string} [label]
 * @param {"legacy" | "downstream"} [dialect]
 * @throws {RoutingDataError}
 */
export function serializeSyncState(state, label = "the sync state", dialect = "legacy") {
  if (!DIALECTS.includes(dialect)) throw new RoutingDataError(`${label}: the state dialect ${JSON.stringify(dialect)} is not one of ${DIALECTS.join(", ")}`);
  const checked = validateSyncState(state, label);
  const wire = dialect === "legacy" ? Object.fromEntries(Object.entries(checked).map(([field, value]) => [field === CANONICAL_FIELD ? LEGACY_FIELD : field, value])) : checked;
  const text = JSON.stringify(wire);
  const bytes = Buffer.byteLength(text, "utf8");
  if (bytes > MAX_VARIABLE_BYTES) {
    throw new RoutingDataError(`${label} is ${bytes} bytes; refusing to send a value above the 48 KB limit of an Actions variable`, { code: "too-large" });
  }
  return text;
}

/** The fields whose values differ between two states (in either spelling), leaving out the bookkeeping fields. */
export function changedFields(before, after) {
  const was = canonical(before);
  const now = canonical(after);
  return SYNC_STATE_FIELDS.filter((field) => !BOOKKEEPING_FIELDS.includes(field) && was[field] !== now[field]);
}

/**
 * The failure transition (AC49, AC50): clears the in-flight pair, counts the failure against the target (a second one in a row for the same
 * target is the second attempt, anything else the first), blocks the target at two attempts and leaves every success cursor alone.
 */
export function failureTransition(state, targetSha, updatedAt) {
  const attempts = state.failedTargetSha === targetSha ? state.failedAttempts + 1 : 1;
  return {
    ...state,
    inFlightRunId: null,
    inFlightTargetSha: null,
    failedAttempts: attempts,
    failedTargetSha: targetSha,
    blockedTargetSha: attempts >= 2 ? targetSha : state.blockedTargetSha,
    updatedAt,
  };
}

/** The success cursors that a failure never moves (AC49). */
export const SUCCESS_CURSORS = Object.freeze(["etag", "lastObservedHeadSha", "lastMergedUpstreamSha", "lastNoopHeadSha", "openPrTargetSha", "openPrNumber"]);
