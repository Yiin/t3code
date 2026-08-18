import { describe, expect, it, vi } from "vite-plus/test";
import { DraftId } from "../composerDraftStore";
import { installInitialPromptIfEmpty } from "./useHandleNewThread";

describe("installInitialPromptIfEmpty", () => {
  it("installs an initial prompt for an empty reused or new draft", () => {
    const setPrompt = vi.fn();
    const target = DraftId.make("draft-12345678");
    installInitialPromptIfEmpty(target, "/plan-epic ", () => "", setPrompt);
    expect(setPrompt).toHaveBeenCalledWith(target, "/plan-epic ");
  });

  it("never overwrites existing composer text", () => {
    const setPrompt = vi.fn();
    installInitialPromptIfEmpty(
      DraftId.make("draft-12345678"),
      "/plan-epic ",
      () => "keep this",
      setPrompt,
    );
    expect(setPrompt).not.toHaveBeenCalled();
  });
});
