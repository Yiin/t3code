// @effect-diagnostics globalProcess:off
// A forge agent can start this binary. Drop forge's URL so t3code agents never
// see it and /cook-epic sends their runs here, not to forge.
delete process.env.FORGE_SERVER_URL;

const isEpicCook = process.argv[2] === "epic" && process.argv[3] === "cook";

if (isEpicCook) {
  const { runEpicCookCli } = await import("./cli/epicCookRunner.ts");
  runEpicCookCli();
} else {
  const { runFullCli } = await import("./fullCli.ts");
  runFullCli();
}
