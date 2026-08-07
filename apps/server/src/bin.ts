// @effect-diagnostics globalProcess:off
const isEpicCook = process.argv[2] === "epic" && process.argv[3] === "cook";

if (isEpicCook) {
  const { runEpicCookCli } = await import("./cli/epicCookRunner.ts");
  runEpicCookCli();
} else {
  const { runFullCli } = await import("./fullCli.ts");
  runFullCli();
}
