// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import { decodeConformanceScenario } from "./scenario.ts";
import { materializeConformanceWorkspace } from "./workspace.ts";

const scenarioPath = process.argv[2];
const root = process.argv[3];
if (scenarioPath === undefined || root === undefined) {
  process.stderr.write("usage: make-workspace.sh <scenario.json> <destination>\n");
  process.exit(2);
}
const scenario = decodeConformanceScenario(JSON.parse(NodeFS.readFileSync(scenarioPath, "utf8")));
NodeFS.mkdirSync(NodePath.resolve(root), { recursive: true });
const workspace = materializeConformanceWorkspace(scenario, NodePath.resolve(root));
process.stdout.write(`${workspace.cwd}\n`);
