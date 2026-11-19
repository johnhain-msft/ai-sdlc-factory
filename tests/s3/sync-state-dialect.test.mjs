// The state dialect (design section F): the fourth field of the sync state was named for one adopter's downstream (`portfolioMainSha`) and is `downstreamMainSha`
// now. A variable that the previous release wrote, or that a rollback returns to, still has the old name, and the code of that release rejects the new one, so the
// engine reads either name and writes the one that it read (`preserve`, the default of the manifest's `state.dialect`), unless the manifest says which name to write.
//
// Four parts: the data functions of sync-state.mjs, the router and the poll-state script persisting in each dialect (a flip converts the variable once and the
// next run writes nothing), the seed of the bootstrap, and a frozen copy of the previous release's schema that documents the rollback window.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import Ajv from "ajv";
import YAML from "yaml";
import { initialSyncState } from "../../bin/lib/actions-variables.mjs";
import { RoutingDataError } from "../../src/routing/schema.mjs";
import { changedFields, dialectOf, LEGACY_FIELD, parseSyncState, resolveWriteDialect, serializeSyncState, SYNC_STATE_FIELDS, validateSyncState } from "../../src/routing/sync-state.mjs";
import { abs, edge, fixture, NOW_ISO, readJson, readText, sha, state } from "./helpers/fixtures.mjs";
import { routerWorld } from "./helpers/harness.mjs";
import { ETAG, flagsFor, HEAD, invoke, TARGET, world as pollWorld } from "./helpers/poll-state-world.mjs";

const NAMES = [LEGACY_FIELD, "downstreamMainSha"];
const text = (name) => readText(fixture("state", name));
/** The text that the variable holds: the fields of the fixture in order, without the whitespace of the file. */
const compact = (name) => JSON.stringify(readJson(fixture("state", name)));
/** The same object with the fourth field under the new name (the position is kept). */
const renamed = (value) => Object.fromEntries(Object.entries(value).map(([key, entry]) => [key === LEGACY_FIELD ? "downstreamMainSha" : key, entry]));

// ---- the data -------------------------------------------------------------------------------------------------------------------------------

test("the canonical field list is the old one with downstreamMainSha in fourth place, and the legacy name is data of its own", () => {
  assert.equal(SYNC_STATE_FIELDS.length, 14);
  assert.equal(SYNC_STATE_FIELDS[3], "downstreamMainSha");
  assert.equal(SYNC_STATE_FIELDS.includes(LEGACY_FIELD), false);
  assert.equal(LEGACY_FIELD, "portfolioMainSha");
  assert.equal(dialectOf({ portfolioMainSha: null }), "legacy");
  assert.equal(dialectOf({ downstreamMainSha: null }), "downstream");
  assert.equal(dialectOf({ downstreamMainSha: null, portfolioMainSha: null }), "legacy", "a value that has both names is invalid, and the one that reads it first takes it as the old one");
});

test("legacy text parses to the canonical object and dialect legacy; the same text in the new name parses to the same object and dialect downstream", () => {
  const legacy = parseSyncState(text("valid-every-field-set.json"), "the variable");
  assert.equal(legacy.dialect, "legacy");
  assert.deepEqual(Object.keys(legacy.state), [...SYNC_STATE_FIELDS]);
  assert.equal(legacy.state.downstreamMainSha, "2222222222222222222222222222222222222222");
  assert.equal(Object.hasOwn(legacy.state, LEGACY_FIELD), false, "in memory there is one name");
  const modern = parseSyncState(JSON.stringify(renamed(readJson(fixture("state", "valid-every-field-set.json")))), "the variable");
  assert.equal(modern.dialect, "downstream");
  assert.deepEqual(modern.state, legacy.state);
  assert.deepEqual(parseSyncState(text("valid-seed-downstream.json"), "seed").state, parseSyncState(text("valid-seed.json"), "seed").state);
  assert.equal(parseSyncState(text("valid-seed-downstream.json"), "seed").dialect, "downstream");
});

test("both names, neither name, or a key that no release wrote is a RoutingDataError that names the shape", () => {
  const refuse = (value, label) =>
    assert.throws(() => parseSyncState(typeof value === "string" ? value : JSON.stringify(value), "the variable"), (error) => error instanceof RoutingDataError && /the variable is not a valid SyncState/.test(error.message), label);
  refuse(text("invalid-both-names.json"), "both names");
  refuse(text("invalid-neither-name.json"), "neither name");
  refuse({ ...readJson(fixture("state", "valid-seed.json")), extra: 1 }, "the old name and a key of nobody's");
  refuse({ ...readJson(fixture("state", "valid-seed-downstream.json")), extra: 1 }, "the new name and a key of nobody's");
  refuse({ ...readJson(fixture("state", "valid-seed.json")), portfolioMainSha: "abc" }, "the old name with a value that is no commit");
  refuse({ ...readJson(fixture("state", "valid-seed-downstream.json")), downstreamMainSha: 7 }, "the new name with a value that is no commit");
  assert.throws(() => validateSyncState(readJson(fixture("state", "invalid-both-names.json"))), RoutingDataError);
  assert.throws(() => validateSyncState(readJson(fixture("state", "invalid-neither-name.json"))), RoutingDataError);
});

test("validateSyncState takes either spelling, checks the pairs as before, and returns the canonical object", () => {
  const legacy = validateSyncState(readJson(fixture("state", "valid-every-field-set.json")));
  const modern = validateSyncState(renamed(readJson(fixture("state", "valid-every-field-set.json"))));
  assert.deepEqual(legacy, modern);
  assert.deepEqual(Object.keys(legacy), [...SYNC_STATE_FIELDS]);
  for (const name of NAMES) {
    const base = { ...readJson(fixture("state", "valid-seed.json")) };
    const value = name === LEGACY_FIELD ? base : renamed(base);
    assert.throws(() => validateSyncState({ ...value, inFlightRunId: 5 }), /inFlightRunId without inFlightTargetSha/, name);
    assert.throws(() => validateSyncState({ ...value, openPrNumber: 5 }), /openPrNumber without openPrTargetSha/, name);
  }
});

test("serializeSyncState in the legacy dialect is byte-identical to what the variable has always held, and legacy is the default", () => {
  for (const name of ["valid-every-field-set.json", "valid-seed.json"]) {
    const { state: parsed } = parseSyncState(text(name), name);
    assert.equal(serializeSyncState(parsed, name, "legacy"), compact(name), name);
    assert.equal(serializeSyncState(parsed, name), compact(name), `${name}: legacy is the default of 0.x`);
    assert.equal(serializeSyncState(readJson(fixture("state", name)), name), compact(name), `${name}: a state that is still spelled the old way serializes the same`);
  }
});

test("serializeSyncState in the downstream dialect has the new name in fourth place and the same 14 fields", () => {
  for (const name of ["valid-every-field-set.json", "valid-seed.json"]) {
    const { state: parsed } = parseSyncState(text(name), name);
    const written = JSON.parse(serializeSyncState(parsed, name, "downstream"));
    assert.deepEqual(Object.keys(written), [...SYNC_STATE_FIELDS]);
    assert.equal(Object.keys(written).length, 14);
    assert.deepEqual(written, renamed(readJson(fixture("state", name))));
    assert.equal(serializeSyncState(parsed, name, "downstream"), JSON.stringify(renamed(readJson(fixture("state", name)))), `${name}: the text is the old text with one key renamed in place`);
  }
  assert.equal(serializeSyncState(readJson(fixture("state", "valid-seed-downstream.json")), "seed", "downstream"), compact("valid-seed-downstream.json"));
});

test("an unknown dialect is refused, and the 48 KB limit is the same in both", () => {
  const { state: parsed } = parseSyncState(text("valid-seed.json"), "seed");
  assert.throws(() => serializeSyncState(parsed, "seed", "sideways"), /dialect/);
  for (const dialect of ["legacy", "downstream"]) {
    assert.throws(() => serializeSyncState({ ...parsed, etag: "e".repeat(48 * 1024) }, "seed", dialect), (error) => error.code === "too-large", dialect);
  }
});

test("a round trip keeps the dialect and the state", () => {
  const { state: parsed } = parseSyncState(text("valid-every-field-set.json"), "x");
  for (const dialect of ["legacy", "downstream"]) {
    const again = parseSyncState(serializeSyncState(parsed, "x", dialect), "x");
    assert.equal(again.dialect, dialect);
    assert.deepEqual(again.state, parsed);
  }
});

test("resolveWriteDialect: preserve writes what was read, the other two settings write their own", () => {
  const table = [
    ["preserve", "legacy", "legacy"],
    ["preserve", "downstream", "downstream"],
    ["legacy", "legacy", "legacy"],
    ["legacy", "downstream", "legacy"],
    ["downstream", "legacy", "downstream"],
    ["downstream", "downstream", "downstream"],
  ];
  for (const [setting, read, expected] of table) assert.equal(resolveWriteDialect(setting, read), expected, `${setting} over ${read}`);
  assert.equal(resolveWriteDialect(undefined, "downstream"), "downstream", "no setting is preserve");
  assert.throws(() => resolveWriteDialect("sideways", "legacy"), /dialect/);
});

test("changedFields compares the canonical names, so a spelling is never a change", () => {
  const { state: legacy } = parseSyncState(text("valid-every-field-set.json"), "x");
  const { state: modern } = parseSyncState(JSON.stringify(renamed(readJson(fixture("state", "valid-every-field-set.json")))), "x");
  assert.deepEqual(changedFields(legacy, modern), []);
  assert.deepEqual(changedFields(legacy, { ...modern, downstreamMainSha: sha("other") }), ["downstreamMainSha"]);
});

test("changedFields takes either spelling on either side: the raw variable and the parsed state of one value differ in nothing, and a real change is still found", () => {
  const rawLegacy = readJson(fixture("state", "valid-every-field-set.json"));
  const rawModern = renamed(rawLegacy);
  assert.equal(Object.hasOwn(rawLegacy, LEGACY_FIELD), true, "the fixture is in the legacy spelling");
  assert.equal(Object.hasOwn(rawModern, "downstreamMainSha"), true);
  assert.deepEqual(changedFields(rawLegacy, rawModern), []);
  assert.deepEqual(changedFields(rawModern, rawLegacy), []);
  assert.deepEqual(changedFields(rawLegacy, rawLegacy), []);
  assert.deepEqual(changedFields(rawLegacy, { ...rawModern, downstreamMainSha: sha("other") }), ["downstreamMainSha"]);
  assert.deepEqual(changedFields({ ...rawLegacy, [LEGACY_FIELD]: sha("other") }, rawModern), ["downstreamMainSha"]);
  assert.deepEqual(changedFields({ ...rawModern, downstreamMainSha: sha("other") }, rawLegacy), ["downstreamMainSha"]);
});

// ---- the router -----------------------------------------------------------------------------------------------------------------------------

const EDGE = edge();
const DOWNSTREAM_HEAD = sha("main-1");
const QUIET_ETAG = 'W/"upstream-etag-1"';
const spelled = (dialect, overrides = {}) => {
  const value = state(overrides, EDGE);
  return dialect === "downstream" ? renamed(value) : value;
};
/** A state for which the router has nothing to record: it has seen this head (304) and this downstream. */
const quiet = (dialect) => spelled(dialect, { etag: QUIET_ETAG, portfolioMainSha: DOWNSTREAM_HEAD });
const settingOf = (setting) => (setting === undefined ? undefined : { state: { dialect: setting } });
const writes = (w) => w.stub.world.writes.map((entry) => JSON.parse(entry.value));
const namesOf = (value) => NAMES.filter((name) => Object.hasOwn(value, name));
const rewriteManifest = (w, setting) => fs.writeFileSync(path.join(w.workspace.dir, "sdlc.yaml"), YAML.stringify({ projects: [], dependencyEdges: [EDGE], ...(setting === undefined ? {} : { state: { dialect: setting } }) }));

function router(t, { variable, setting, upstream } = {}) {
  const w = routerWorld({ edge: EDGE, state: variable, upstream, manifestExtra: settingOf(setting) });
  t.after(() => w.cleanup());
  return w;
}

test("the router writes the name that it read when the manifest does not say (preserve), in both dialects", async (t) => {
  for (const read of ["legacy", "downstream"]) {
    for (const setting of [undefined, "preserve"]) {
      const w = router(t, { variable: spelled(read), setting });
      const result = await w.go();
      assert.equal(result.code, 0, `${read}/${setting}: ${result.stderr}`);
      assert.ok(writes(w).length >= 1, `${read}/${setting}: the dispatch is recorded`);
      for (const value of writes(w)) {
        assert.deepEqual(namesOf(value), [read === "legacy" ? LEGACY_FIELD : "downstreamMainSha"], `${read}/${setting}`);
        assert.deepEqual(Object.keys(value).map((key) => (key === LEGACY_FIELD ? "downstreamMainSha" : key)), [...SYNC_STATE_FIELDS], `${read}/${setting}: 14 fields in the canonical order`);
      }
      assert.equal(w.state()[read === "legacy" ? LEGACY_FIELD : "downstreamMainSha"], DOWNSTREAM_HEAD, `${read}/${setting}: the downstream that it saw is recorded under that name`);
    }
  }
});

test("state.dialect downstream converts a legacy variable on its first write and state.dialect legacy converts a downstream one back", async (t) => {
  const forward = router(t, { variable: spelled("legacy"), setting: "downstream" });
  assert.equal((await forward.go()).code, 0);
  assert.ok(writes(forward).length >= 1);
  for (const value of writes(forward)) assert.deepEqual(namesOf(value), ["downstreamMainSha"]);
  assert.equal(forward.state().downstreamMainSha, DOWNSTREAM_HEAD);
  const back = router(t, { variable: spelled("downstream"), setting: "legacy" });
  assert.equal((await back.go()).code, 0);
  for (const value of writes(back)) assert.deepEqual(namesOf(value), [LEGACY_FIELD]);
  assert.equal(back.state()[LEGACY_FIELD], DOWNSTREAM_HEAD);
  const same = router(t, { variable: spelled("legacy"), setting: "legacy" });
  assert.equal((await same.go()).code, 0);
  for (const value of writes(same)) assert.deepEqual(namesOf(value), [LEGACY_FIELD]);
});

test("a flip with nothing else to record writes exactly once, and the next run writes nothing", async (t) => {
  const w = router(t, { variable: quiet("legacy"), upstream: { head: sha("sha0") } });
  const first = await w.go();
  assert.equal(first.code, 0, first.stderr);
  assert.equal(w.decisions()[0].action, "noop-304", "the world is quiet: this head was seen");
  assert.equal(writes(w).length, 0, "no setting, nothing to record: nothing is written");

  rewriteManifest(w, "downstream");
  assert.equal((await w.go()).code, 0);
  assert.equal(writes(w).length, 1, "the flip converts the variable in place");
  assert.deepEqual(namesOf(writes(w)[0]), ["downstreamMainSha"]);
  assert.deepEqual(changedFields(parseSyncState(JSON.stringify(quiet("legacy")), "x").state, parseSyncState(JSON.stringify(writes(w)[0]), "x").state), [], "and it changes nothing but the name");
  assert.equal((await w.go()).code, 0);
  assert.equal(writes(w).length, 1, "the next run writes nothing");

  rewriteManifest(w, "legacy");
  assert.equal((await w.go()).code, 0);
  assert.equal(writes(w).length, 2, "the rollback converts it back, once");
  assert.deepEqual(namesOf(writes(w)[1]), [LEGACY_FIELD]);
  assert.equal((await w.go()).code, 0);
  assert.equal(writes(w).length, 2);

  rewriteManifest(w, undefined);
  assert.equal((await w.go()).code, 0);
  assert.equal(writes(w).length, 2, "removing the setting is preserve: the variable is left as it is");
});

test("the router that cannot read the setting keeps preserving, and says so", async (t) => {
  const w = router(t, { variable: spelled("downstream"), setting: "sideways" });
  const result = await w.go();
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /state\.dialect/, "the log names the setting");
  for (const value of writes(w)) assert.deepEqual(namesOf(value), ["downstreamMainSha"]);
});

// ---- the poll-state script -----------------------------------------------------------------------------------------------------------------

function poller(t, { start, setting, pulls } = {}) {
  const w = pollWorld({ edgeValue: EDGE, start, ...(pulls === undefined ? {} : { pulls }) });
  t.after(() => w.workspace.cleanup());
  if (setting !== undefined) rewriteManifest(w, setting);
  return w;
}
const polled = (w) => w.stub.world.writes.map((entry) => JSON.parse(entry.value));
const NOOP = (overrides = {}) => flagsFor(EDGE, { "--head-sha": HEAD, "--base-sha": HEAD, ...overrides });

test("the success path writes the name that it read, converts under a setting, and records a verified pull request in either dialect", async (t) => {
  for (const read of ["legacy", "downstream"]) {
    const preserved = poller(t, { start: spelled(read) });
    assert.equal((await invoke(preserved, NOOP())).code, 0);
    assert.deepEqual(polled(preserved).map(namesOf), [[read === "legacy" ? LEGACY_FIELD : "downstreamMainSha"]], `noop under preserve, ${read}`);
    const opened = poller(t, { start: spelled(read) });
    const result = await invoke(opened, flagsFor(EDGE));
    assert.equal(result.code, 0, result.stderr);
    assert.deepEqual(polled(opened).map(namesOf), [[read === "legacy" ? LEGACY_FIELD : "downstreamMainSha"]], `pull request under preserve, ${read}`);
    for (const [setting, expected] of [["legacy", LEGACY_FIELD], ["downstream", "downstreamMainSha"]]) {
      const converted = poller(t, { start: spelled(read), setting });
      assert.equal((await invoke(converted, NOOP())).code, 0);
      assert.deepEqual(polled(converted).map(namesOf), [[expected]], `noop under ${setting}, ${read}`);
    }
  }
});

test("the failure paths write the name that they read, or the one that the setting names", async (t) => {
  for (const read of ["legacy", "downstream"]) {
    const failing = poller(t, { start: spelled(read) });
    const argv = ["--record-failure", "--slug", EDGE.upstreamSlug, "--target-sha", TARGET, "--workflow-id", "cascade-ai-widgets-to-portal"];
    assert.equal((await invoke(failing, argv)).code, 0);
    assert.deepEqual(polled(failing).map(namesOf), [[read === "legacy" ? LEGACY_FIELD : "downstreamMainSha"]], `record-failure under preserve, ${read}`);
    const converted = poller(t, { start: spelled(read), setting: read === "legacy" ? "downstream" : "legacy" });
    assert.equal((await invoke(converted, argv)).code, 0);
    assert.deepEqual(polled(converted).map(namesOf), [[read === "legacy" ? "downstreamMainSha" : LEGACY_FIELD]], `record-failure under the other setting, ${read}`);
  }
});

test("a verification that comes back negative records the failure in the name that it read, or in the one that the setting names", async (t) => {
  for (const read of ["legacy", "downstream"]) {
    const preserved = poller(t, { start: spelled(read), pulls: [] });
    assert.equal((await invoke(preserved, flagsFor(EDGE))).code, 1);
    assert.deepEqual(polled(preserved).map(namesOf), [[read === "legacy" ? LEGACY_FIELD : "downstreamMainSha"]], `no open pull request under preserve, ${read}`);
    const converted = poller(t, { start: spelled(read), pulls: [], setting: read === "legacy" ? "downstream" : "legacy" });
    assert.equal((await invoke(converted, flagsFor(EDGE))).code, 1);
    assert.deepEqual(polled(converted).map(namesOf), [[read === "legacy" ? "downstreamMainSha" : LEGACY_FIELD]], `no open pull request under the other setting, ${read}`);
    assert.equal(polled(converted)[0].failedAttempts, 1, "it is the failure that was recorded, in the converted spelling");
  }
});

test("a flip with nothing else to record is one write, and then none, for the poll-state script too", async (t) => {
  const start = spelled("legacy", { etag: ETAG, lastObservedHeadSha: TARGET, lastNoopHeadSha: TARGET });
  const w = poller(t, { start });
  assert.equal((await invoke(w, NOOP())).code, 0);
  assert.equal(polled(w).length, 0, "the state already says what the noop would record");
  rewriteManifest(w, "downstream");
  assert.equal((await invoke(w, NOOP())).code, 0);
  assert.equal(polled(w).length, 1);
  assert.deepEqual(namesOf(polled(w)[0]), ["downstreamMainSha"]);
  assert.equal((await invoke(w, NOOP())).code, 0);
  assert.equal(polled(w).length, 1, "the next run writes nothing");
});

test("a setting that is not preserve, legacy or downstream stops the poll-state script before it writes anything", async (t) => {
  const w = poller(t, { start: spelled("legacy"), setting: "sideways" });
  const result = await invoke(w, NOOP());
  assert.equal(result.code, 1, result.stderr);
  assert.match(result.stderr, /state\.dialect/);
  assert.equal(polled(w).length, 0);
});

// ---- the seed of the bootstrap --------------------------------------------------------------------------------------------------------------

test("the seed is legacy unless it is asked for the new name, and both seeds are valid states", () => {
  const baseline = sha("baseline");
  const legacy = initialSyncState(baseline, NOW_ISO);
  assert.deepEqual(Object.keys(legacy), Object.keys(readJson(fixture("state", "valid-seed.json"))));
  assert.equal(Object.hasOwn(legacy, LEGACY_FIELD), true);
  assert.deepEqual(initialSyncState(baseline, NOW_ISO, "legacy"), legacy);
  const modern = initialSyncState(baseline, NOW_ISO, "downstream");
  assert.deepEqual(Object.keys(modern), Object.keys(readJson(fixture("state", "valid-seed-downstream.json"))));
  assert.deepEqual(modern, renamed(legacy));
  assert.deepEqual(parseSyncState(JSON.stringify(modern), "seed").state, parseSyncState(JSON.stringify(legacy), "seed").state);
  assert.throws(() => initialSyncState(baseline, NOW_ISO, "sideways"), /dialect/);
});

// ---- the previous release (the rollback target) ----------------------------------------------------------------------------------------------

test("N-1: the previous release's definition of the state accepts everything that is written under preserve or legacy and rejects a downstream write", async (t) => {
  const v0 = new Ajv({ strict: false, allErrors: true }).compile(readJson(abs("tests", "fixtures", "compat", "sync-state.v0.schema.json")));
  const accepts = (value, label) => assert.equal(v0(value), true, `${label}: ${JSON.stringify(v0.errors)}`);
  const rejects = (value, label) => assert.equal(v0(value), false, label);

  for (const name of ["valid-every-field-set.json", "valid-seed.json"]) {
    const { state: parsed } = parseSyncState(text(name), name);
    accepts(JSON.parse(serializeSyncState(parsed, name, "legacy")), `${name} written as legacy`);
    rejects(JSON.parse(serializeSyncState(parsed, name, "downstream")), `${name} written as downstream`);
  }
  accepts(initialSyncState(sha("b"), NOW_ISO), "the default seed");
  rejects(initialSyncState(sha("b"), NOW_ISO, "downstream"), "the downstream seed");

  // a variable that the previous release wrote, handled by this one under every setting that does not convert it
  for (const setting of [undefined, "preserve", "legacy"]) {
    const w = router(t, { variable: spelled("legacy"), setting });
    assert.equal((await w.go()).code, 0);
    assert.ok(writes(w).length >= 1);
    for (const value of writes(w)) accepts(value, `the router under ${setting ?? "no setting"}`);
    const p = poller(t, { start: spelled("legacy"), setting });
    assert.equal((await invoke(p, NOOP())).code, 0);
    assert.ok(polled(p).length >= 1);
    for (const value of polled(p)) accepts(value, `the poll-state script under ${setting ?? "no setting"}`);
  }
  const flipped = router(t, { variable: spelled("legacy"), setting: "downstream" });
  assert.equal((await flipped.go()).code, 0);
  for (const value of writes(flipped)) rejects(value, "the rollback window opens with the flip: the previous release cannot read what a downstream write leaves");
});
