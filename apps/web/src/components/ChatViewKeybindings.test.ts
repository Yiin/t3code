import { assert, describe, it } from "vite-plus/test";
import {
  resolveChatKeybindingAction,
  shouldTypeToFocusComposer,
  type TypeToFocusComposerEvent,
} from "./ChatViewKeybindings";

const event = (overrides: Partial<TypeToFocusComposerEvent> = {}): TypeToFocusComposerEvent => ({
  defaultPrevented: false,
  isComposing: false,
  metaKey: false,
  ctrlKey: false,
  altKey: false,
  key: "a",
  editableTarget: false,
  interactiveTarget: false,
  floatingLayerOpen: false,
  ...overrides,
});

describe("resolveChatKeybindingAction", () => {
  it.each([
    ["terminal.toggle", { type: "terminal.toggle" }],
    ["rightPanel.toggle", { type: "rightPanel.toggle" }],
    ["terminal.split", { type: "terminal.split", direction: "horizontal" }],
    ["terminal.splitVertical", { type: "terminal.split", direction: "vertical" }],
    ["terminal.close", { type: "terminal.close" }],
    ["terminal.new", { type: "terminal.new" }],
    ["diff.toggle", { type: "diff.toggle" }],
    ["modelPicker.toggle", { type: "modelPicker.toggle" }],
    ["script.test.run", { type: "projectScript.run", scriptId: "test" }],
  ] as const)("routes %s", (command, expected) => {
    assert.deepEqual(
      resolveChatKeybindingAction(command, { terminalFocus: false, rightPanelTerminal: false }),
      expected,
    );
  });

  it("returns null for an unrelated command", () => {
    assert.strictEqual(
      resolveChatKeybindingAction("chat.new", { terminalFocus: false, rightPanelTerminal: false }),
      null,
    );
  });
});

describe("shouldTypeToFocusComposer", () => {
  it("allows a plain printable key", () => {
    assert.strictEqual(shouldTypeToFocusComposer(event()), true);
  });

  it.each([
    ["default-prevented", { defaultPrevented: true }],
    ["composing", { isComposing: true }],
    ["modified", { ctrlKey: true }],
    ["non-printable", { key: "Enter" }],
    ["editable target", { editableTarget: true }],
    ["interactive target", { interactiveTarget: true }],
    ["floating layer", { floatingLayerOpen: true }],
  ] as const)("rejects %s", (_, overrides) => {
    assert.strictEqual(shouldTypeToFocusComposer(event(overrides)), false);
  });
});
