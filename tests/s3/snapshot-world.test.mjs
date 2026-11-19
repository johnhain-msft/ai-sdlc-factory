import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import YAML from "yaml";
import { seededSnapshotWorld } from "./helpers/qa-round2-worlds.mjs";

test("the seeded snapshot fixture routes declared classifier verdicts with a real baseline and the runs-only scope", async (t) => {
  for (const [code, action] of [[0, "noop-unchanged-snapshot"], [1, "dispatch-ai-adaptation"]]) {
    const world = seededSnapshotWorld({ classifier: { code } });
    t.after(() => world.cleanup());
    const manifest = YAML.parse(fs.readFileSync(world.w.workspace.path("sdlc.yaml"), "utf8"));
    assert.equal(world.edge.initialBaselineSha, world.upstreamShas[0]);
    assert.equal(world.w.edge.initialBaselineSha, world.upstreamShas[0]);
    assert.equal(JSON.parse(world.w.env.EDGE_JSON).initialBaselineSha, world.upstreamShas[0]);
    assert.deepEqual(manifest.dependencyEdges[0].syncScopes, ["runs-only"]);
    assert.equal(manifest.dependencyEdges[0].initialBaselineSha, world.upstreamShas[0]);

    const result = await world.go();
    assert.equal(result.code, 0, `${result.stderr}\n${result.stdout}`);
    assert.equal(world.w.decisions()[0].action, action);
    if (code === 0) {
      assert.deepEqual(world.w.stub.world.dispatches, []);
      assert.equal(world.w.state().lastNoopHeadSha, world.upstreamHead);
    } else {
      assert.equal(world.w.stub.world.dispatches.length, 1);
      assert.equal(world.w.stub.world.dispatches[0].body.inputs.sync_scope, "runs-only");
      assert.equal(world.w.state().inFlightTargetSha, world.upstreamHead);
    }
    assert.equal(fs.readFileSync(path.join(world.downstreamDir, "content/pipelines/run-data.json"), "utf8"), '{"entries":["fixture"]}\n');
    assert.deepEqual(world.leftovers(), []);
  }
});
