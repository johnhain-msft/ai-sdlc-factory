// File effects of the recording shell stand-in: validate the declared invocation and reproduce only the writes needed by the runtime fixture.
import fs from "node:fs";
import path from "node:path";

const [tool, ...args] = process.argv.slice(2);
const plan = JSON.parse(fs.readFileSync(process.env.STUB_PLAN, "utf8"));
const normal = (value) => value.replaceAll("\\", "/").replace(/^\/([a-z])\//i, (_, drive) => `${drive.toUpperCase()}:/`);
const same = (left, right) => Array.isArray(right) && left.length === right.length && left.every((value, index) => normal(value) === normal(right[index]));
const call = args.join(" ");
if (!(plan.allowed[tool] ?? []).some((allowed) => same(args, allowed))) {
  process.stderr.write(`stub ${tool}: unexpected command: ${call}\n`);
  process.exit(97);
}
if (tool === "npm" && same(args, plan.inputCheck)) {
  process.stdout.write(fs.readFileSync(process.env.STUB_INPUT_REPORT, "utf8"));
  process.exit(Number(process.env.STUB_INPUT_RC ?? 0));
}
if (tool === "npm" && same(args, plan.inputAccept)) {
  for (const file of plan.acceptFiles) {
    const document = JSON.parse(fs.readFileSync(file, "utf8"));
    document.commit = process.env.UPSTREAM_SHA;
    fs.writeFileSync(file, `${JSON.stringify(document, null, 2)}\n`);
  }
}
if (tool === "npm" && same(args, plan.build) && plan.generated) {
  const { source, target } = plan.generated;
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.copyFileSync(source, target);
}
