// dependencyEdges[].agentSandbox.bashCommands and dependencyEdges[].model: what the agent of a cascade workflow may run besides its default list, the refusal of the
// executables that reach the network, and the model of its engine. Both keys are optional, and a cascade workflow that does not use them renders what it always did.
import assert from "node:assert/strict";
import test from "node:test";
import { minimalManifest, projectOf, withRequest } from "./helpers/fixtures.mjs";
import { renderMinimal } from "./helpers/policy.mjs";

const IDS = { mechanical: "cascade-mechanical-alpha-to-beta", "ai-adaptation": "cascade-ai-alpha-to-beta" };
const edgeOf = (manifest) => manifest.dependencyEdges[0];
/** The minimal fleet with its one edge in `mode`, changed further by `change`. */
const render = (mode, change = () => undefined, request) =>
  renderMinimal((copy) => {
    edgeOf(copy).mode = mode;
    change(copy);
  }, request);
const withoutBash = (workflow) => ({ ...workflow.frontmatter, tools: { ...workflow.frontmatter.tools, bash: null } });
const withoutModel = (workflow) => ({ ...workflow.frontmatter, engine: Object.fromEntries(Object.entries(workflow.frontmatter.engine).filter(([key]) => key !== "model")) });
const otherFiles = (files, id) => [...files].filter(([file]) => file !== `.github/workflows/${id}.md`);

for (const mode of ["mechanical", "ai-adaptation"]) {
  const id = IDS[mode];

  test(`${mode}: agentSandbox.bashCommands extend the bash allowlist of the cascade agent with the words that they name, sorted and once each, and nothing else of any workflow changes`, () => {
    const plain = render(mode);
    const extended = render(mode, (copy) => (edgeOf(copy).agentSandbox = { bashCommands: ["xargs", "awk", "git", "cd", "rg", "python3", "g++"] }));
    assert.ok(plain.ok && extended.ok, JSON.stringify(plain.errors ?? extended.errors));
    const before = plain.workflow(id).frontmatter.tools.bash;
    assert.deepEqual(extended.workflow(id).frontmatter.tools.bash, [...new Set([...before, "awk", "g++", "python3", "rg", "xargs"])].sort());
    assert.ok(before.includes("cd") && before.includes("git"), "cd and git are in the default list");
    for (const word of ["gh", "curl", "wget", "*"]) assert.equal(extended.workflow(id).frontmatter.tools.bash.includes(word), false, word);
    assert.deepEqual(withoutBash(extended.workflow(id)), withoutBash(plain.workflow(id)), "the rest of the frontmatter");
    assert.equal(extended.workflow(id).body, plain.workflow(id).body, "and the prompt");
    assert.deepEqual(otherFiles(extended.files, id), otherFiles(plain.files, id), "and every other file of the fleet");
  });

  test(`${mode}: an empty agentSandbox, or an empty list, changes nothing`, () => {
    const plain = render(mode).files.get(`.github/workflows/${id}.md`);
    for (const agentSandbox of [{}, { bashCommands: [] }]) {
      assert.equal(render(mode, (copy) => (edgeOf(copy).agentSandbox = agentSandbox)).files.get(`.github/workflows/${id}.md`), plain, JSON.stringify(agentSandbox));
    }
  });

  test(`${mode}: a manifest cannot give a cascade agent gh, curl or wget, in any case, and the refusal names the edge and the entry`, () => {
    for (const word of ["gh", "curl", "wget", "GH", "Curl", "WGET"]) {
      for (const position of [0, 1]) {
        const bashCommands = position === 0 ? [word, "awk"] : ["awk", word];
        const refused = render(mode, (copy) => (edgeOf(copy).agentSandbox = { bashCommands }));
        assert.equal(refused.ok, false, `${word} at ${position}`);
        assert.deepEqual(refused.errors, [
          `drift-bash-command-forbidden: edge 'alpha-to-beta' (sdlc.yaml#/dependencyEdges/0/agentSandbox/bashCommands/${position}): '${word}' reaches the network or the GitHub API, and a cascade agent publishes only through its create_pull_request safe output`,
        ]);
      }
    }
    const several = render(mode, (copy) => (edgeOf(copy).agentSandbox = { bashCommands: ["curl", "jq", "wget"] }));
    assert.deepEqual(several.errors.map((error) => /bashCommands\/(\d+)\): '(\w+)'/.exec(error).slice(1)), [["0", "curl"], ["2", "wget"]], "one refusal for each entry");
  });

  test(`${mode}: dependencyEdges[].model is the model of the engine of the cascade workflow, after its id, and nothing else of any workflow changes`, () => {
    const plain = render(mode);
    assert.equal("model" in plain.workflow(id).frontmatter.engine, false, "no key, no model");
    const named = render(mode, (copy) => (edgeOf(copy).model = "gpt-5.1-codex"));
    assert.ok(named.ok, JSON.stringify(named.errors));
    const { engine } = named.workflow(id).frontmatter;
    assert.equal(engine.model, "gpt-5.1-codex");
    assert.deepEqual(Object.keys(engine), ["id", "model", ...Object.keys(plain.workflow(id).frontmatter.engine).filter((key) => key !== "id")]);
    assert.deepEqual(withoutModel(named.workflow(id)), plain.workflow(id).frontmatter, "the rest of the frontmatter");
    assert.equal(named.workflow(id).body, plain.workflow(id).body, "and the prompt");
    assert.deepEqual(otherFiles(named.files, id), otherFiles(plain.files, id), "the model of an edge is not the model of a drift workflow, an implementation workflow or another cascade");
  });

  test(`${mode}: the model of an edge reaches the engine object of every engine that a request can select`, () => {
    for (const [mode_, secret, engine, variable] of [
      ["copilot-requests", undefined, "copilot", undefined],
      ["copilot-pat", undefined, "copilot", "COPILOT_GITHUB_TOKEN"],
      ["api-key", "ANTHROPIC_API_KEY", "claude", "ANTHROPIC_API_KEY"],
      ["api-key", "GEMINI_API_KEY", "gemini", "GEMINI_API_KEY"],
      ["api-key", "OPENAI_API_KEY", "codex", "OPENAI_API_KEY"],
    ]) {
      const rendered = render(mode, (copy) => {
        if (secret) copy.engineApiKeySecret = secret;
        edgeOf(copy).model = "model-of-the-edge";
        edgeOf(copy).agentSandbox = { bashCommands: ["awk"] };
      }, withRequest({ engineAuthMode: mode_ }));
      assert.ok(rendered.ok, JSON.stringify(rendered.errors));
      const { frontmatter } = rendered.workflow(id);
      const env = variable === undefined ? {} : { env: { [variable]: `\${{ secrets.${mode_ === "copilot-pat" ? "COPILOT_GITHUB_TOKEN" : secret} }}` } };
      assert.deepEqual(frontmatter.engine, { id: engine, model: "model-of-the-edge", ...env }, `${mode_}/${engine}`);
      // codex cannot enforce an allowlist, so the compiler gets the wildcard that it accepts, whatever the edge adds
      if (engine === "codex") assert.deepEqual(frontmatter.tools.bash, ["*"]);
      else assert.ok(frontmatter.tools.bash.includes("awk") && !frontmatter.tools.bash.includes("*"), `${engine}: the allowlist is kept and extended`);
    }
  });

  test(`${mode}: dependencyEdges[].model that the schema refuses is never rendered: a space, a shell metacharacter, an expression and 129 characters`, () => {
    for (const model of ["two words", "a;b", "a$(b)", "${{ secrets.X }}", "a".repeat(129), "", "-x"]) {
      const refused = render(mode, (copy) => (edgeOf(copy).model = model));
      assert.equal(refused.ok, false, JSON.stringify(model));
      assert.ok(refused.errors.some((error) => error.includes("/dependencyEdges/0/model") || error.startsWith("manifest-expression-opener: ")), refused.errors.join("\n"));
    }
  });
}

test("the model of a project and the model of an edge are independent: each reaches only its own workflows", () => {
  const rendered = render("ai-adaptation", (copy) => {
    edgeOf(copy).model = "model-of-the-edge";
    projectOf(copy, "alpha-service").driftAudit.model = "model-of-the-project";
  });
  assert.ok(rendered.ok, JSON.stringify(rendered.errors));
  const modelOf = (id) => rendered.workflow(id).frontmatter.engine.model;
  assert.deepEqual(
    ["drift-alpha-service", "implement-alpha-service", IDS["ai-adaptation"], "sdlc-onboard"].map(modelOf),
    ["model-of-the-project", "model-of-the-project", "model-of-the-edge", undefined],
  );
});

test("the minimal manifest without the new keys renders the engine of every workflow without a model, whatever the mode of its edge", () => {
  for (const mode of ["mechanical", "ai-adaptation"]) {
    const rendered = render(mode);
    for (const [file, text] of rendered.files) if (file.endsWith(".md")) assert.equal(/^\s+model:/m.test(text.split("\n---\n")[0]), false, `${mode}: ${file}`);
  }
  assert.equal(minimalManifest().dependencyEdges[0].model, undefined);
});
