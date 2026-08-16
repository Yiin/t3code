import { describeHarnessHomeOverlayConformance } from "./harnessHomeOverlay.testkit.ts";
import { codexHarnessHomeManifest } from "./CodexHomeLayout.ts";

describeHarnessHomeOverlayConformance({
  name: "Codex harness home overlay",
  manifest: codexHarnessHomeManifest,
  defaultHomePath: "/tmp/codex-default-home",
  sampleSharedFile: "config.toml",
});
