import type {
  KeybindingCommand,
  ProjectScript,
  ResolvedKeybindingsConfig,
} from "@t3tools/contracts";
import { useEffect } from "react";
import { isCommandPaletteOpen } from "../commandPaletteBus";
import { projectScriptIdFromCommand } from "~/projectScripts";
import { getTerminalFocusOwner } from "../lib/terminalFocus";
import { resolveShortcutCommand } from "../keybindings";

export type ChatKeybindingContext = {
  readonly terminalFocus: boolean;
  readonly terminalOpen: boolean;
  readonly modelPickerOpen: boolean;
  readonly rightPanelTerminal: boolean;
};

export type ChatKeybindingAction =
  | { readonly type: "terminal.toggle" }
  | { readonly type: "rightPanel.toggle" }
  | { readonly type: "terminal.split"; readonly direction: "horizontal" | "vertical" }
  | { readonly type: "terminal.close" }
  | { readonly type: "terminal.new" }
  | { readonly type: "diff.toggle" }
  | { readonly type: "modelPicker.toggle" }
  | { readonly type: "projectScript.run"; readonly scriptId: string };

export function resolveChatKeybindingAction(
  command: KeybindingCommand | null,
  _context: Pick<ChatKeybindingContext, "terminalFocus" | "rightPanelTerminal">,
): ChatKeybindingAction | null {
  if (command === "terminal.toggle") return { type: "terminal.toggle" };
  if (command === "rightPanel.toggle") return { type: "rightPanel.toggle" };
  if (command === "terminal.split") {
    return {
      type: "terminal.split",
      direction: "horizontal",
    };
  }
  if (command === "terminal.splitVertical") {
    return {
      type: "terminal.split",
      direction: "vertical",
    };
  }
  if (command === "terminal.close") return { type: "terminal.close" };
  if (command === "terminal.new") return { type: "terminal.new" };
  if (command === "diff.toggle") return { type: "diff.toggle" };
  if (command === "modelPicker.toggle") return { type: "modelPicker.toggle" };

  const scriptId = projectScriptIdFromCommand(command ?? "");
  return scriptId === null ? null : { type: "projectScript.run", scriptId };
}

export type TypeToFocusComposerEvent = {
  readonly defaultPrevented: boolean;
  readonly isComposing: boolean;
  readonly metaKey: boolean;
  readonly ctrlKey: boolean;
  readonly altKey: boolean;
  readonly key: string;
  readonly editableTarget: boolean;
  readonly interactiveTarget: boolean;
  readonly floatingLayerOpen: boolean;
};

export function shouldTypeToFocusComposer(event: TypeToFocusComposerEvent): boolean {
  if (event.defaultPrevented || event.isComposing) return false;
  if (event.metaKey || event.ctrlKey || event.altKey) return false;
  if (event.key.length !== 1) return false;
  if (event.editableTarget || event.interactiveTarget || event.floatingLayerOpen) return false;
  return true;
}

export type ChatKeybindingActions = {
  readonly setTerminalOpen: (open: boolean) => void;
  readonly toggleTerminalVisibility: () => void;
  readonly toggleRightPanel: () => void;
  readonly splitTerminal: (direction?: "horizontal" | "vertical") => void;
  readonly splitPanelTerminal: (direction?: "horizontal" | "vertical") => void;
  readonly closeTerminal: (terminalId: string) => void;
  readonly closePanelTerminal: (terminalId: string) => void;
  readonly createNewTerminal: () => void;
  readonly addTerminalSurface: () => void;
  readonly onToggleDiff: () => void;
  readonly toggleModelPicker: () => void;
  readonly insertTextAtEnd: (text: string) => boolean;
  readonly runProjectScript: (script: ProjectScript) => void | Promise<void>;
};

export function useChatKeybindings(input: {
  readonly activeThreadId: string | null;
  readonly activeProject: { readonly scripts: ReadonlyArray<ProjectScript> } | null;
  readonly keybindings: ResolvedKeybindingsConfig;
  readonly terminalOpen: boolean;
  readonly rightPanelTerminal: boolean;
  readonly activeTerminalId: string;
  readonly activePanelTerminalId: string | null;
  readonly composerOpen: () => boolean;
  readonly actions: ChatKeybindingActions;
}): void {
  useEffect(() => {
    const handler = (event: globalThis.KeyboardEvent) => {
      if (!input.activeThreadId || isCommandPaletteOpen()) return;
      const terminalFocusOwner = getTerminalFocusOwner();
      if (event.defaultPrevented && terminalFocusOwner === null) return;
      const context = {
        terminalFocus: terminalFocusOwner !== null,
        terminalOpen: input.terminalOpen,
        modelPickerOpen: input.composerOpen(),
        rightPanelTerminal: input.rightPanelTerminal,
      };

      if (!context.terminalFocus && !context.modelPickerOpen) {
        const canTypeToFocus = shouldTypeToFocusComposer({
          defaultPrevented: event.defaultPrevented,
          isComposing: event.isComposing,
          metaKey: event.metaKey,
          ctrlKey: event.ctrlKey,
          altKey: event.altKey,
          key: event.key,
          editableTarget: eventPathContainsSelector(event, TYPE_TO_FOCUS_EDITABLE_SELECTOR),
          interactiveTarget: eventPathContainsSelector(event, TYPE_TO_FOCUS_INTERACTIVE_SELECTOR),
          floatingLayerOpen: document.querySelector(TYPE_TO_FOCUS_FLOATING_LAYER_SELECTOR) !== null,
        });
        if (canTypeToFocus && input.actions.insertTextAtEnd(event.key)) {
          event.preventDefault();
          event.stopPropagation();
          return;
        }
      }

      const command = resolveShortcutCommand(event, input.keybindings, { context });
      const action = resolveChatKeybindingAction(command, context);
      if (!action) return;
      if (action.type === "projectScript.run") {
        const script = input.activeProject?.scripts.find((entry) => entry.id === action.scriptId);
        if (!script) return;
      }
      event.preventDefault();
      event.stopPropagation();
      switch (action.type) {
        case "terminal.toggle":
          input.actions.toggleTerminalVisibility();
          return;
        case "rightPanel.toggle":
          input.actions.toggleRightPanel();
          return;
        case "terminal.split":
          if (terminalFocusOwner === "right-panel")
            input.actions.splitPanelTerminal(action.direction);
          else {
            if (!input.terminalOpen) input.actions.setTerminalOpen(true);
            input.actions.splitTerminal(action.direction);
          }
          return;
        case "terminal.close":
          if (terminalFocusOwner === "right-panel") {
            if (input.activePanelTerminalId) {
              input.actions.closePanelTerminal(input.activePanelTerminalId);
            }
          } else if (input.terminalOpen) {
            input.actions.closeTerminal(input.activeTerminalId);
          }
          return;
        case "terminal.new":
          if (terminalFocusOwner === "right-panel") input.actions.addTerminalSurface();
          else {
            if (!input.terminalOpen) input.actions.setTerminalOpen(true);
            input.actions.createNewTerminal();
          }
          return;
        case "diff.toggle":
          input.actions.onToggleDiff();
          return;
        case "modelPicker.toggle":
          input.actions.toggleModelPicker();
          return;
        case "projectScript.run":
          void input.actions.runProjectScript(
            input.activeProject!.scripts.find((entry) => entry.id === action.scriptId)!,
          );
          return;
      }
    };
    window.addEventListener("keydown", handler, true);
    return () => window.removeEventListener("keydown", handler, true);
  }, [input]);
}

const TYPE_TO_FOCUS_EDITABLE_SELECTOR = [
  "input",
  "textarea",
  "select",
  '[contenteditable="true"]',
  '[contenteditable="plaintext-only"]',
  '[role="textbox"]',
].join(",");
const TYPE_TO_FOCUS_INTERACTIVE_SELECTOR = [
  "button",
  "a[href]",
  "summary",
  '[role="button"]',
  '[role="checkbox"]',
  '[role="menuitem"]',
  '[role="option"]',
  '[role="radio"]',
  '[role="switch"]',
  '[role="tab"]',
].join(",");
const TYPE_TO_FOCUS_FLOATING_LAYER_SELECTOR = [
  '[data-slot="dialog"]',
  '[data-slot="menu-popup"]',
  '[data-slot="select-popup"]',
  '[data-slot="popover-popup"]',
  '[data-slot="combobox-popup"]',
  '[data-slot="autocomplete-popup"]',
].join(",");

function eventPathContainsSelector(event: Event, selector: string): boolean {
  const path = event.composedPath();
  if (path.length === 0 && event.target) path.push(event.target);
  return path.some((target) => target instanceof Element && target.closest(selector));
}
