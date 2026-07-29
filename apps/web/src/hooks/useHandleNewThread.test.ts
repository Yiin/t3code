import { describe, expect, it, vi } from "vite-plus/test";
import type { DraftId } from "../composerDraftStore";
import { installInitialPromptIfEmpty } from "./useHandleNewThread";

describe("installInitialPromptIfEmpty", () => {
  it("installs an initial prompt for an empty reused or new draft", () => {
    const setPrompt = vi.fn();
    const target = "draft-12345678" as DraftId;
    installInitialPromptIfEmpty(target, "/plan-epic ", () => "", setPrompt);
    expect(setPrompt).toHaveBeenCalledWith(target, "/plan-epic ");
  });

  it("never overwrites existing composer text", () => {
    const setPrompt = vi.fn();
    installInitialPromptIfEmpty(
      "draft-12345678" as DraftId,
      "/plan-epic ",
      () => "keep this",
      setPrompt,
    );
    expect(setPrompt).not.toHaveBeenCalled();
  });
});
