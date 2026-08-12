/**
 * Pins the native share-target filters to the widened share model.
 *
 * A config-plugin change only proves itself on a real native build, so this
 * covers the half a host without a simulator can check: the values this repo
 * declares, and the two artifacts the expo-sharing plugin generates from them
 * — the iOS activation rule in the extension's Info.plist, and the Android
 * `<data>` entries of the SEND intent filters.
 */
import { describe, expect, it } from "@effect/vitest";
import { PROVIDER_SEND_TURN_MAX_ATTACHMENTS } from "@t3tools/contracts";
import type { ExpoConfig } from "expo/config";
import { parseIntentFilters } from "expo-sharing/plugin/build/android/parseIntentFilters.js";
import createInfoPlistFile from "expo-sharing/plugin/build/ios/createInfoPlistFile.js";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import appConfig from "./app.config.ts";

type ActivationRule = Record<string, unknown>;

interface SharingPluginProps {
  readonly ios?: { readonly activationRule?: ActivationRule };
  readonly android?: {
    readonly singleShareMimeTypes?: ReadonlyArray<string>;
    readonly multipleShareMimeTypes?: ReadonlyArray<string>;
  };
}

function sharingPluginProps(config: ExpoConfig): SharingPluginProps {
  const entry = (config.plugins ?? []).find(
    (plugin): plugin is [string, SharingPluginProps] =>
      Array.isArray(plugin) && plugin[0] === "expo-sharing",
  );
  if (!entry) {
    throw new Error("app.config.ts no longer configures the expo-sharing plugin.");
  }
  return entry[1];
}

const props = sharingPluginProps(appConfig);

describe("native share target", () => {
  it("accepts a file and a movie on iOS, not images alone", () => {
    const rule = props.ios?.activationRule;
    expect(rule).toEqual({
      supportsText: true,
      supportsWebUrlWithMaxCount: 1,
      supportsImageWithMaxCount: PROVIDER_SEND_TURN_MAX_ATTACHMENTS,
      supportsMovieWithMaxCount: PROVIDER_SEND_TURN_MAX_ATTACHMENTS,
      supportsFileWithMaxCount: PROVIDER_SEND_TURN_MAX_ATTACHMENTS,
    });
  });

  it("writes the widened activation rule into the extension's Info.plist", () => {
    const directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3code-share-target-"));
    try {
      createInfoPlistFile(
        directory,
        "group.com.t3tools.t3code",
        "t3code",
        props.ios?.activationRule ?? {},
      );
      const plist = NodeFS.readFileSync(NodePath.join(directory, "Info.plist"), "utf8");
      expect(plist).toContain("NSExtensionActivationSupportsFileWithMaxCount");
      expect(plist).toContain("NSExtensionActivationSupportsMovieWithMaxCount");
      expect(plist).toContain("NSExtensionActivationSupportsImageWithMaxCount");
    } finally {
      NodeFS.rmSync(directory, { force: true, recursive: true });
    }
  });

  it("accepts any mime type on Android, for one share and for many", () => {
    expect(props.android?.singleShareMimeTypes).toEqual(["*/*"]);
    expect(props.android?.multipleShareMimeTypes).toEqual(["*/*"]);
  });

  it("renders both Android mime lists into SEND intent filters", () => {
    // parseIntentFilters is the plugin's own validator: it throws on a mime
    // type prebuild would reject, so this proves `*/*` survives the manifest.
    const single = parseIntentFilters([...(props.android?.singleShareMimeTypes ?? [])], "single");
    const multiple = parseIntentFilters(
      [...(props.android?.multipleShareMimeTypes ?? [])],
      "multiple",
    );
    expect(single.action).toBe("android.intent.action.SEND");
    expect(single.data).toEqual([{ mimeType: "*/*" }]);
    expect(multiple.action).toBe("android.intent.action.SEND_MULTIPLE");
    expect(multiple.data).toEqual([{ mimeType: "*/*" }]);
  });
});
